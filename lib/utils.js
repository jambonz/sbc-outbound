const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
const debug = require('debug')('jambonz:sbc-outbound');

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, padCrypto, teams) {
  const from = req.getParsedHeader('from');
  const rtpCopy = JSON.parse(JSON.stringify(rtpCharacteristics));
  const srtpCopy = JSON.parse(JSON.stringify(srtpCharacteristics));

  if (padCrypto) {
    srtpCopy['default'].flags.push('SDES-pad');
    srtpCopy['teams'].flags.push('SDES-pad');
  }

  const srtpOpts = teams ? srtpCopy['teams'] : srtpCopy['default'];
  const dstOpts = dstIsUsingSrtp ? srtpOpts : rtpCopy;
  const srcOpts = srcIsUsingSrtp ? srtpOpts : rtpCopy;

  /* webrtc clients (e.g. sipjs) send DMTF via SIP INFO */
  if ((srcIsUsingSrtp || dstIsUsingSrtp) && !teams) {
    dstOpts.flags.push('inject DTMF');
    srcOpts.flags.push('inject DTMF');
  }
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection'],
    'record call': process.env.JAMBONES_RECORD_ALL_CALLS ? 'yes' : 'no'
  };
  return {
    common,
    uas: {
      tag: from.params.tag,
      mediaOpts: srcOpts
    },
    uac: {
      tag: null,
      mediaOpts: dstOpts
    }
  };
}

const selectHostPort = (hostport, protocol) => {
  debug(`selectHostPort: ${hostport}, ${protocol}`);
  const sel = hostport
    .split(',')
    .map((hp) => {
      const arr = /(.*)\/(.*):(.*)/.exec(hp);
      return [arr[1], arr[2], arr[3]];
    })
    .filter((hp) => {
      return hp[0] === protocol && hp[1] !== '127.0.0.1';
    });
  return sel[0];
};

const pingMs = (logger, srf, gateway, fqdns) => {
  const uri = `sip:${gateway}`;
  const proxy = `sip:${gateway}:5061;transport=tls`;
  fqdns.forEach((fqdn) => {
    const contact = `<sip:${fqdn}:5061;transport=tls>`;
    srf.request(uri, {
      method: 'OPTIONS',
      proxy,
      headers: {
        'Contact': contact,
        'From': contact,
      }
    }).catch((err) => logger.error(err, `Error pinging MS Teams at ${gateway}`));
  });
};

const pingMsTeamsGateways = (logger, srf) => {
  const {lookupAllTeamsFQDNs} = srf.locals.dbHelpers;
  lookupAllTeamsFQDNs()
    .then((fqdns) => {
      if (fqdns.length > 0) {
        ['sip.pstnhub.microsoft.com', 'sip2.pstnhub.microsoft.com', 'sip3.pstnhub.microsoft.com']
          .forEach((gw) => {
            setInterval(pingMs.bind(this, logger, srf, gw, fqdns), 60000);
          });
      }
      return;
    })
    .catch((err) => {
      logger.error(err, 'Error looking up all ms teams fqdns');
    });
};

const makeAccountCallCountKey = (sid) => `outcalls:account:${sid}`;
const makeSPCallCountKey = (sid) => `outcalls:sp:${sid}`;
const makeAppCallCountKey = (sid) => `outcalls:app:${sid}`;

const equalsIgnoreOrder = (a, b) => {
  if (a.length !== b.length) return false;
  const uniqueValues = new Set([...a, ...b]);
  for (const v of uniqueValues) {
    const aCount = a.filter((e) => e === v).length;
    const bCount = b.filter((e) => e === v).length;
    if (aCount !== bCount) return false;
  }
  return true;
};

const  systemHealth = async(redisClient, ping, getCount) => {
  await Promise.all([redisClient.ping(), ping()]);
  return getCount();
};

const createHealthCheckApp = (port, logger) => {
  const express = require('express');
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  return new Promise((resolve) => {
    app.listen(port, () => {
      logger.info(`Health check server started at http://localhost:${port}`);
      resolve(app);
    });
  });
};

const nudgeCallCounts = async(logger, sids, nudgeOperator, writers) => {
  const {service_provider_sid, account_sid, application_sid} = sids;
  const {writeCallCount, writeCallCountSP, writeCallCountApp} = writers;
  const nudges = [];
  const writes = [];

  logger.debug(sids, 'nudgeCallCounts');

  if (process.env.JAMBONES_TRACK_SP_CALLS) {
    const key = makeSPCallCountKey(service_provider_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
    const key = makeAccountCallCountKey(account_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
    const key = makeAppCallCountKey(application_sid);
    nudges.push(nudgeOperator(key));
  }
  else {
    nudges.push(() => Promise.resolve(null));
  }

  try {
    const [callsSP, calls, callsApp] = await Promise.all(nudges);
    logger.debug({
      calls, callsSP, callsApp,
      service_provider_sid, account_sid, application_sid}, 'call counts after adjustment');
    if (process.env.JAMBONES_TRACK_SP_CALLS) {
      writes.push(writeCallCountSP({service_provider_sid, calls_in_progress: callsSP}));
    }

    if (process.env.JAMBONES_TRACK_ACCOUNT_CALLS || process.env.JAMBONES_HOSTING) {
      writes.push(writeCallCount({service_provider_sid, account_sid, calls_in_progress: calls}));
    }

    if (process.env.JAMBONES_TRACK_APP_CALLS && application_sid) {
      writes.push(writeCallCountApp({service_provider_sid, account_sid, application_sid, calls_in_progress: callsApp}));
    }

    /* write the call counts to the database */
    Promise.all(writes).catch((err) => logger.error({err}, 'Error writing call counts'));

    return {callsSP, calls, callsApp};
  } catch (err) {
    logger.error(err, 'error incrementing call counts');
  }

  return {callsSP: null, calls: null, callsApp: null};
};

module.exports = {
  makeRtpEngineOpts,
  selectHostPort,
  pingMsTeamsGateways,
  makeAccountCallCountKey,
  makeSPCallCountKey,
  equalsIgnoreOrder,
  systemHealth,
  createHealthCheckApp,
  nudgeCallCounts
};

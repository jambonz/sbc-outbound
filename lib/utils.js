const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
const debug = require('debug')('jambonz:sbc-outbound');
const CIDRMatcher = require('cidr-matcher');
const dns = require('dns');
const sdpTransform = require('sdp-transform');

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

  /** Allow feature server to send DTMF to the call excepts call from/to teams */
  if (!teams) {
    if (!dstOpts.flags.includes('inject DTMF')) {
      dstOpts.flags.push('inject DTMF');
    }
    if (!srcOpts.flags.includes('inject DTMF')) {
      srcOpts.flags.push('inject DTMF');
    }
  }
  /** By default use strict source to secure aganst RTPInject vuln,
   * set env var to true to disable it and use media handover instead */
  const disableStrictSource = process.env.RTPENGINE_DISABLE_STRICT_SOURCE || false;
  dstOpts.flags.push(disableStrictSource ? 'media handover' : 'strict source');
  srcOpts.flags.push(disableStrictSource ?  'media handover' : 'strict source');

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
      mediaOpts: {
        ...dstOpts,
        ...(process.env.JAMBONES_CODEC_OFFER_WITH_ORDER &&
          { codec: { offer: process.env.JAMBONES_CODEC_OFFER_WITH_ORDER.split(','), strip: 'all' } }),
      }
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

/**
 * nudgeCallCounts - increment or decrement call counts in redis
 *
 *              current nudge value
 * -----------------------------------------
 *  why    |     -1     |    0    |    1    |
 * -----------------------------------------
 *  init   |    no-op   |    +1   |    N/A  |
 * failure |    N/A     |    -1   |    -1   |
 * complete|    N/A     |    N/A  |    -1   |
 *
 *
 */

const shouldNudge = (why, req) => {
  const {nudge, logger} = req.locals;
  let modifyCount = false;
  const originalNudge = nudge;

  switch (why) {
    case 'init':
      if (nudge === 0) {
        // normal case: new call, increment call count
        req.locals.nudge = 1;
        modifyCount = true;
      }
      else if (nudge === -1) {
        // extremely quick cancel, don't increment call count
        req.locals.nudge = 0;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'failure':
      if (nudge === 1) {
        // normal case of call failed for any reason, decrement call count
        req.locals.nudge = 0;
        modifyCount = true;
      }
      else if (nudge === 0) {
        // very quick failure dont decrement call count
        req.locals.nudge = -1;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    case 'complete':
      if (nudge === 1) {
        // normal case of call completed, decrement call count
        req.locals.nudge = 0;
        modifyCount = true;
      }
      else {
        logger.info(`shouldNudge: unexpected nudge value ${nudge} for ${why}`);
      }
      break;
    default:
      logger.info(`shouldNudge: unexpected why value ${why}`);
      break;
  }

  logger.info(`shouldNudge: '${why}': updating count: ${modifyCount}, nudge: ${originalNudge} -> ${req.locals.nudge}`);
  return modifyCount;
};

const nudgeCallCounts = async(req, why, sids, nudgeOperator, writers) => {
  const {logger} = req.locals;
  const {service_provider_sid, account_sid, application_sid, callId} = sids;
  const {writeCallCount, writeCallCountSP, writeCallCountApp} = writers;
  const nudges = [];
  const writes = [];

  if (!shouldNudge(why, req)) {
    return {callsSP: null, calls: null, callsApp: null};
  }

  if (process.env.JAMBONES_DEBUG_CALL_COUNTS) {
    const {srf} = require('..');
    const {addKey, deleteKey} = srf.locals.realtimeDbHelpers;

    if (why === 'init') {
      // save for 3 days
      await addKey(`debug:outcalls:${account_sid}:${callId}`, new Date().toISOString(), 259200);
    }
    else {
      await deleteKey(`debug:outcalls:${account_sid}:${callId}`);
    }
  }

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

const isPrivateVoipNetwork = async(uri) => {
  const {srf, logger} = require('..');
  const {privateNetworkCidr} = srf.locals;

  if (privateNetworkCidr) {
    try {
      const matcher = new CIDRMatcher(privateNetworkCidr.split(','));
      const arr = /sips?:.*@(.*?)(:\d+)?(;.*)$/.exec(uri);
      if (arr) {
        const input = arr[1];
        let addresses;
        if (input.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
          addresses = [input];
        } else {
          addresses = await dns.resolve4(input);
        }
        for (const ip of addresses) {
          if (matcher.contains(ip)) {
            return true;
          }
        }
      }
    } catch (err) {
      logger.info({err, privateNetworkCidr},
        'Error checking private network CIDR, probably misconfigured must be a comma separated list of CIDRs');
    }
  }
  return false;
};

function makeBlacklistGatewayKey(key) {
  return `blacklist-sip-gateway:${key}`;
}

async function isBlackListedSipGateway(client, logger, sip_gateway_sid) {
  try {
    return await client.exists(makeBlacklistGatewayKey(sip_gateway_sid)) === 1;
  } catch (err) {
    logger.error({err}, `isBlackListedSipGateway: error while checking blacklist for ${sip_gateway_sid}`);
  }
}

const makeFullMediaReleaseKey = (callId) => {
  return `b_sdp:${callId}`;
};
const makePartnerFullMediaReleaseKey = (callId) => {
  return `a_sdp:${callId}`;
};

function isValidDomainOrIP(input) {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9.-]+)(:\d+)?$/;
  // eslint-disable-next-line max-len
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(:\d+)?$/;

  if (domainRegex.test(input) || ipRegex.test(input)) {
    return true;
  }

  return false; // Invalid input
}
const removeVideoSdp = (sdp) => {
  const parsedSdp = sdpTransform.parse(sdp);
  // Filter out video media sections, keeping only non-video media
  parsedSdp.media = parsedSdp.media.filter((media) => media.type !== 'video');
  return sdpTransform.write(parsedSdp);
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
  nudgeCallCounts,
  isPrivateVoipNetwork,
  isBlackListedSipGateway,
  makeFullMediaReleaseKey,
  makePartnerFullMediaReleaseKey,
  isValidDomainOrIP,
  removeVideoSdp
};

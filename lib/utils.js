const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
const debug = require('debug')('jambonz:sbc-outbound');

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, teams = false) {
  const from = req.getParsedHeader('from');
  const srtpOpts = teams ? srtpCharacteristics['teams'] : srtpCharacteristics['default'];
  const dstOpts = dstIsUsingSrtp ? srtpOpts : rtpCharacteristics;
  const srcOpts = srcIsUsingSrtp ? srtpOpts : rtpCharacteristics;
  const common = {
    'call-id': req.get('Call-ID'),
    'replace': ['origin', 'session-connection']
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

const makeCallCountKey = (sid) => `${sid}:outcalls`;

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

module.exports = {
  makeRtpEngineOpts,
  selectHostPort,
  pingMsTeamsGateways,
  makeCallCountKey,
  equalsIgnoreOrder,
  systemHealth,
  createHealthCheckApp
};

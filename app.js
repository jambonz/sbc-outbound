const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');

const Srf = require('drachtio-srf');
const srf = new Srf('sbc-outbound');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {
  writeCdrs,
  queryCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
});
const StatsCollector = require('@jambonz/stats-collector');
const stats = new StatsCollector(logger);
const CallSession = require('./lib/call-session');
const setNameRtp = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
const rtpServers = [];
const {
  performLcr,
  lookupAllTeamsFQDNs,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {createHash, retrieveHash, incrKey, decrKey, retrieveSet} = require('@jambonz/realtimedb-helpers')({
  host: process.env.JAMBONES_REDIS_HOST || 'localhost',
  port: process.env.JAMBONES_REDIS_PORT || 6379
}, logger);

const activeCallIds = new Map();

srf.locals = {...srf.locals,
  stats,
  writeCdrs,
  writeAlerts,
  AlertType,
  queryCdrs,
  activeCallIds,
  dbHelpers: {
    performLcr,
    lookupAllTeamsFQDNs,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid
  },
  realtimeDbHelpers: {
    createHash,
    retrieveHash,
    incrKey,
    decrKey
  }
};
const {initLocals, checkLimits, route} = require('./lib/middleware')(srf, logger, {
  host: process.env.JAMBONES_REDIS_HOST,
  port: process.env.JAMBONES_REDIS_PORT || 6379
});
const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {emitter: stats});
srf.locals.getRtpEngine = getRtpEngine;

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
    const last = hp.split(',').pop();
    const arr = /^(.*)\/(.*):(\d+)$/.exec(last);
    logger.info(`connected to drachtio listening on ${hp}: adding ${arr[2]} to sbc_addresses table`);
    srf.locals.sipAddress = arr[2];
  });
}
else {
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

srf.use('invite', [initLocals, checkLimits, route]);
srf.invite((req, res) => {
  const session = new CallSession(logger, req, res);
  session.connect();
});

/* update call stats periodically */
setInterval(() => {
  stats.gauge('sbc.sip.calls.count', activeCallIds.size, ['direction:outbound']);
}, 5000);

const arrayCompare = (a, b) => {
  if (a.length !== b.length) return false;
  const uniqueValues = new Set([...a, ...b]);
  for (const v of uniqueValues) {
    const aCount = a.filter((e) => e === v).length;
    const bCount = b.filter((e) => e === v).length;
    if (aCount !== bCount) return false;
  }
  return true;
};

/* update rtpengines periodically */
if (process.env.JAMBONES_RTPENGINES) {
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set);
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!arrayCompare(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${process.env.RTPENGINE_PORT || 22222}`));
        rtpServers.length = 0;
        Array.prototype.push.apply(rtpServers, newArray);
      }
    } catch (err) {
      logger.error({err}, 'Error setting new rtpengines');
    }
  };

  setInterval(() => {
    getActiveRtpServers();
  }, 30000);
  getActiveRtpServers();
}

const {pingMsTeamsGateways} = require('./lib/utils');
pingMsTeamsGateways(logger, srf);

module.exports = {srf};

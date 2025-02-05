const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
if (process.env.JAMBONES_REDIS_SENTINELS) {
  assert.ok(process.env.JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional');
} else {
  assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_NETWORK_CIDR env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');

const Srf = require('drachtio-srf');
const srf = new Srf('sbc-outbound');
const CIDRMatcher = require('cidr-matcher');
const {equalsIgnoreOrder, pingMsTeamsGateways, createHealthCheckApp, systemHealth} = require('./lib/utils');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
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
  ping,
  lookupOutboundCarrierForAccount,
  lookupAllTeamsFQDNs,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid,
  lookupSipGatewaysByCarrier,
  lookupCarrierBySid,
  queryCallLimits,
  lookupCarrierByAccountLcr,
  lookupSystemInformation
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  port: process.env.JAMBONES_MYSQL_PORT || 3306,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {
  client: redisClient,
  createHash,
  retrieveHash,
  incrKey,
  decrKey,
  retrieveSet,
  isMemberOfSet,
  addKey,
  deleteKey,
  retrieveKey
} = require('@jambonz/realtimedb-helpers')({}, logger);

const activeCallIds = new Map();
const Emitter = require('events');
const idleEmitter = new Emitter();

srf.locals = {...srf.locals,
  stats,
  writeCallCount,
  writeCallCountSP,
  writeCallCountApp,
  writeCdrs,
  writeAlerts,
  AlertType,
  queryCdrs,
  activeCallIds,
  idleEmitter,
  privateNetworkCidr: process.env.PRIVATE_VOIP_NETWORK_CIDR || null,
  dbHelpers: {
    ping,
    lookupOutboundCarrierForAccount,
    lookupAllTeamsFQDNs,
    lookupAccountBySipRealm,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid,
    lookupSipGatewaysByCarrier,
    lookupCarrierBySid,
    queryCallLimits,
    lookupCarrierByAccountLcr,
    lookupSystemInformation
  },
  realtimeDbHelpers: {
    client: redisClient,
    addKey,
    deleteKey,
    retrieveKey,
    createHash,
    retrieveHash,
    incrKey,
    decrKey,
    isMemberOfSet
  }
};
const {initLocals, checkLimits, route} = require('./lib/middleware')(srf, logger, redisClient);
const ngProtocol = process.env.JAMBONES_NG_PROTOCOL || 'udp';
const ngPort = process.env.RTPENGINE_PORT || ('udp' === ngProtocol ? 22222 : 8080);
const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {
  //emitter: stats,
  dtmfListenPort: process.env.DTMF_LISTEN_PORT || 22225,
  protocol: ngProtocol
});
srf.locals.getRtpEngine = getRtpEngine;

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  const cidrs = process.env.JAMBONES_NETWORK_CIDR
    .split(',')
    .map((s) => s.trim());
  logger.info({cidrs}, 'internal network CIDRs');
  const matcher = new CIDRMatcher(cidrs);

  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);

    const hostports = hp.split(',');
    for (const hp of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`sbc public address: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
      }
      else if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`sbc private address: ${hostport}`);
        srf.locals.privateSipAddress = hostport;
      }
    }
  });
}
else {
  logger.info(`listening in outbound mode on port ${process.env.DRACHTIO_PORT}`);
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

if (process.env.K8S || process.env.HTTP_PORT) {
  const PORT = process.env.HTTP_PORT || 3000;
  const healthCheck = require('@jambonz/http-health-check');

  const getCount = () => srf.locals.activeCallIds.size;

  createHealthCheckApp(PORT, logger)
    .then((app) => {
      healthCheck({
        app,
        logger,
        path: '/',
        fn: getCount
      });
      healthCheck({
        app,
        logger,
        path: '/system-health',
        fn: systemHealth.bind(null, redisClient, ping, getCount)
      });
      return;
    })
    .catch((err) => {
      logger.error({err}, 'Error creating health check server');
    });
}
if ('test' !== process.env.NODE_ENV) {
  /* update call stats periodically as well as definition of private network cidr */
  setInterval(async() => {
    stats.gauge('sbc.sip.calls.count', activeCallIds.size, ['direction:outbound',
      `instance_id:${process.env.INSTANCE_ID || 0}`]);

    const r = await lookupSystemInformation();
    if (r) {
      if (r.private_network_cidr !== srf.locals.privateNetworkCidr) {
        logger.info(`updating private network cidr from ${srf.locals.privateNetworkCidr} to ${r.private_network_cidr}`);
        srf.locals.privateNetworkCidr = r.private_network_cidr;
      }
      // Update system log level
      if (r.log_level) {
        logger.level = r.log_level;
      }
    }
  }, 20000);
}

const lookupRtpServiceEndpoints = (lookup, serviceName) => {
  lookup(serviceName, {family: 4, all: true}, (err, addresses) => {
    if (err) {
      logger.error({err}, `Error looking up ${serviceName}`);
      return;
    }
    logger.debug({addresses, rtpServers}, `dns lookup for ${serviceName} returned`);
    const addrs = addresses.map((a) => a.address);
    if (!equalsIgnoreOrder(addrs, rtpServers)) {
      rtpServers.length = 0;
      Array.prototype.push.apply(rtpServers, addrs);
      logger.info({rtpServers}, 'rtpserver endpoints have been updated');
      setRtpEngines(rtpServers.map((a) => `${a}:${ngPort}`));
    }
  });
};

if (process.env.K8S_RTPENGINE_SERVICE_NAME) {
  /* poll dns for endpoints every so often */
  const arr = /^(.*):(\d+)$/.exec(process.env.K8S_RTPENGINE_SERVICE_NAME);
  const svc = arr[1];
  logger.info(`rtpengine(s) will be found at dns name: ${svc}`);
  const {lookup} = require('dns');
  lookupRtpServiceEndpoints(lookup, svc);
  setInterval(lookupRtpServiceEndpoints.bind(null, lookup, svc), process.env.RTPENGINE_DNS_POLL_INTERVAL || 10000);
}
else if (process.env.JAMBONES_RTPENGINES) {
  /* static list of rtpengines */
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  /* poll redis periodically for rtpengines that have registered via OPTIONS ping */
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set);
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!equalsIgnoreOrder(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${ngPort}`));
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

pingMsTeamsGateways(logger, srf);

process.on('SIGUSR2', handle.bind(null));
process.on('SIGTERM', handle.bind(null));

function handle(signal) {
  logger.info(`got signal ${signal}`);
  if (process.env.K8S) {
    if (0 === activeCallIds.size) {
      logger.info('exiting immediately since we have no calls in progress');
      process.exit(0);
    }
    else {
      idleEmitter.once('idle', () => process.exit(0));
    }
  }
}

module.exports = {srf, logger};

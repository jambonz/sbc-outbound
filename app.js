const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_RTPENGINES, 'missing JAMBONES_RTPENGINES env var');

const Srf = require('drachtio-srf');
const srf = new Srf();
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {route, setLogger} = require('./lib/middleware');
const CallSession = require('./lib/call-session');
const {performLcr} = require('jambonz-db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
srf.locals.dbHelpers = {performLcr};

// parse rtpengines
srf.locals.rtpEngines = process.env.JAMBONES_RTPENGINES
  .split(',')
  .map((hp) => {
    const arr = /^(.*):(.*)$/.exec(hp.trim());
    if (arr) return {host: arr[1], port: parseInt(arr[2])};
  });
assert.ok(srf.locals.rtpEngines.length > 0, 'JAMBONES_RTPENGINES must be an array host:port addresses');

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  srf.listen({host: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

srf.use('invite', [setLogger(logger), route({
  host: process.env.JAMBONES_REDIS_HOST,
  port: process.env.JAMBONES_REDIS_PORT || 6379
})]);
srf.invite((req, res) => {
  const session = new CallSession(logger, req, res);
  session.connect();
});

module.exports = {srf};

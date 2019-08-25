const Srf = require('drachtio-srf');
const srf = new Srf();
const config = require('config');
const logger = require('pino')(config.get('logging'));
const {route, setLogger} = require('./lib/middleware');
const debug = require('debug')('jambonz:sbc-outbound');

// disable logging in test mode
if (process.env.NODE_ENV === 'test') {
  const noop = () => {};
  logger.info = logger.debug = noop;
  logger.child = () => {return {info: noop, error: noop, debug: noop};};
}

// config dictates whether to use outbound or inbound connections
if (config.has('drachtio.host')) {
  srf.connect(config.get('drachtio'));
  srf.on('connect', (err, hp) => {
    debug(`connected to drachtio at ${hp}`);
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  srf.listen(config.get('drachtio'));
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.error(err, 'Error connecting to drachtio');
  });
}

srf.use('invite', [setLogger(logger), route(config.get('redis'))]);
srf.invite(require('./lib/invite'));

module.exports = {srf};

const debug = require('debug')('jambonz:sbc-outbound');
const parseUri = require('drachtio-srf').parseUri;
const Registrar = require('jambonz-mw-registrar');
const {selectHostPort}= require('./utils');

function setLogger(logger) {
  return (req, res, next) => {
    debug('setting logger');
    req.locals = req.locals || {};
    req.locals.logger = logger.child({callId: req.get('Call-ID')});
    next();
  };
};

function route(opts) {
  const registrar = new Registrar(opts);
  return async(req, res, next) => {
    const logger = req.locals.logger;
    req.locals = req.locals || {};
    logger.info(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);
    debug(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);

    // E.164 numbers go through least-cost routing and out a sip trunk
    if (req.calledNumber.startsWith('+')) {
      logger.info('sending call to LCR');
      req.locals.target = 'lcr';
      return next();
    }

    // otherwise, its a call to a sip user
    const uri = parseUri(req.uri);
    const aor = `sip:${uri.user}@${uri.host}`;
    debug(`searching for registered user ${aor}`);
    const reg = await registrar.query(aor);
    if (!reg) {
      logger.info(`sbc-outbound call to a non-registered user ${aor}`);
      debug(`sbc-outbound call to a non-registered user ${aor}`);

      return res.send(404, 'User Not Found');
    }

    // user is registered..find out which sbc is handling it
    // if us => we can put the call through
    // if another sbc => proxy the call there
    if (req.server.hostport !== reg.sbcAddress) {
      //proxy
      const proxyAddress = selectHostPort(reg.sbcAddress, 'udp');
      logger.info(`proxying call to SBC at ${proxyAddress}`);
      debug(`proxying call to SBC at ${proxyAddress}`);
      req.proxy(`sip:${proxyAddress[1]}`, {followRedirects: true});
      return;
    }

    req.locals.registration = reg;
    req.locals.target = 'user';

    logger.info(`sending call to registered user at ${JSON.stringify(req.locals.registration)}`);
    debug(`sending call to registered user at ${JSON.stringify(req.locals.registration)}`);

    next();
  };
}

module.exports = {
  setLogger,
  route
};

const debug = require('debug')('jambonz:sbc-outbound');
const parseUri = require('drachtio-srf').parseUri;
const Registrar = require('jambonz-mw-registrar');
const {selectHostPort} = require('./utils');

function setLogger(logger) {
  return (req, res, next) => {
    debug('setting logger');
    req.locals = req.locals || {};
    req.locals.logger = logger.child({callId: req.get('Call-ID')});
    next();
  };
}

function isLocalUri(host, req) {
  return req.server.hostport.includes(host);
}

function route(opts) {
  const registrar = new Registrar(opts);
  return async(req, res, next) => {
    const uri = parseUri(req.uri);
    const aor = `sip:${uri.user}@${uri.host}`;
    const logger = req.locals.logger;
    req.locals = req.locals || {};

    logger.info(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);
    debug(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);

    let reg;

    if (!/^[0-9\.]+$/.test(uri.host)) {
      // uri host is not a dot-decimal address, so try to look up user
      logger.debug(`searching for registered user ${aor}`);
      reg = await registrar.query(aor);
      if (reg) {
        // user is registered..find out which sbc is handling it
        // us => we can put the call through
        // other sbc => proxy the call there
        logger.debug(`found registered user ${JSON.stringify(reg)}`);
        if (req.server.hostport !== reg.sbcAddress) {
          //proxy
          const proxyAddress = selectHostPort(reg.sbcAddress, 'udp');
          logger.info(`proxying call to SBC at ${proxyAddress}`);
          logger.debug(`proxying call to SBC at ${proxyAddress}`);
          req.proxy(`sip:${proxyAddress[1]}`);
          return;
        }
        req.locals.registration = reg;
        req.locals.target = 'user';
        return next();
      }
    }
    else if (!isLocalUri(uri.host, req)) {
      logger.info(`forwarding call to ${req.uri}`);
      req.locals.target = 'forward';
      return next();
    }

    // if the called number is digits only (after possible leading plus sign) and long enough, do lcr
    if (!/^\d+$/.test(req.calledNumber.slice(1)) || req.calledNumber.length < 8) {
      debug(`unable to route call to ${aor}; no registered user found`);
      logger.info(`unable to route call to ${aor}; no registered user found`);
      return res.send(404);
    }

    logger.info('sending call to LCR');
    debug('sending call to LCR');
    req.locals.target = 'lcr';
    next();
  };
}

module.exports = {
  setLogger,
  route
};

const debug = require('debug')('jambonz:sbc-outbound');
const parseUri = require('drachtio-srf').parseUri;
const srf = require('drachtio-srf');
const Registrar = require('jambonz-mw-registrar');
const {selectHostPort} = require('./utils');

function setLogger(logger) {
  return (req, res, next) => {
    debug('setting logger');
    req.locals = req.locals || {};
    req.locals.logger = logger.child({callId: req.get('Call-ID')});
    req.srf.locals.stats.increment('sbc.invites', ['direction:outbound']);
    next();
  };
}

function isLocalUri(host, req) {
  debug({hostport: req.server.hostport}, `is ${host} local?`);
  return req.server.hostport.includes(host);
}

function route(opts) {
  const registrar = new Registrar(opts);
  return async(req, res, next) => {
    const logger = req.locals.logger;
    const {lookupAccountBySipRealm} = req.srf.locals.dbHelpers;
    logger.info(`received outbound INVITE to ${req.uri} from server at ${req.server.hostport}`);
    const uri = parseUri(req.uri);
    if (!uri.user || !uri.host) {
      logger.info({uri: req.uri}, 'invalid request-uri on outbound call, rejecting');
      res.send(404, {
        headers: {
          'X-Reason': 'invalid request-uri'
        }
      });
      const tags = ['accepted:no', 'sipStatus:404'];
      req.srf.locals.stats.increment('sbc.originations', tags);
      return;
    }
    const aor = `${uri.user}@${uri.host}`;
    req.locals = req.locals || {};

    debug(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);

    let reg;
    const dotDecimalHost = /^[0-9\.]+$/.test(uri.host);

    if (req.has('X-MS-Teams-FQDN') && req.has('X-MS-Teams-Tenant-FQDN')) {
      logger.debug('This is a call to ms teams');
      req.locals.target = 'teams';
      return next();
    }
    else if (!dotDecimalHost) {
      // uri host is not a dot-decimal address, so try to look up user
      debug(`searching for registered user ${aor}`);
      reg = await registrar.query(aor);
      if (reg) {
        // user is registered..find out which sbc is handling it
        // us => we can put the call through
        // other sbc => proxy the call there
        logger.info({details: reg}, `sending call to registered user ${aor}`);
        if (req.server.hostport !== reg.sbcAddress) {
          //proxy
          const proxyAddress = selectHostPort(reg.sbcAddress, 'udp');
          logger.info(`proxying call to SBC at ${proxyAddress}`);
          //req.proxy(`sip:${proxyAddress[1]}`);
          req.srf.proxyRequest(req, `sip:${proxyAddress[1]}`);
          return;
        }
        req.locals.registration = reg;
        req.locals.target = 'user';
        return next();
      }
      else {
        // if the sip domain is one of ours return 404
        const account = await lookupAccountBySipRealm(uri.host);
        if (account) {
          logger.info({host: uri.host, account}, `returning 404 to unregistered user in valid domain: ${req.uri}`);
          res.send(404);
          return;
        }
      }
    }
    if (!dotDecimalHost || !isLocalUri(uri.host, req)) {
      // call that needs to be forwarded to a sip endpoint
      logger.info(`forwarding call to sip endpoint ${req.uri}`);
      req.locals.target = 'forward';
      return next();
    }

    // if the called number is digits only (after possible leading plus sign) and long enough, do lcr
    if (!/^\d+$/.test(req.calledNumber.slice(1)) || req.calledNumber.length < 8) {
      debug(`unable to route call to ${aor}; no registered user found`);
      logger.info(`unable to route call to ${aor}; no registered user found`);
      const tags = ['accepted:no', 'sipStatus:404'];
      req.srf.locals.stats.increment('sbc.originations', tags);
      return res.send(404);
    }

    debug('sending call to LCR');
    req.locals.target = 'lcr';
    next();
  };
}

module.exports = {
  setLogger,
  route
};

const Emitter = require('events');
const {makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError} = require('drachtio-srf');
const {parseUri} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-outbound');

/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  if (uri && uri.user) return `sip:${uri.user}@localhost`;
  return 'sip:anonymous@localhost';
};
const createBLegToHeader = (req) => {
  const from = req.getParsedHeader('To');
  const uri = parseUri(from.uri);
  if (uri && uri.user) return `sip:${uri.user}@localhost`;
  return 'sip:localhost';
};

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.performLcr = this.srf.locals.dbHelpers.performLcr;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.useWss = req.locals.registration && req.locals.registration.protocol === 'wss';
    this.stats = this.srf.locals.stats;
    this.activeCallIds = this.srf.locals.activeCallIds;
  }

  async connect() {
    const engine = this.srf.locals.getRtpEngine();
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      const tags = ['accepted:no', 'sipStatus:408'];
      this.stats.increment('sbc.originations', tags);
      return this.res.send(480);
    }
    debug(`got engine: ${JSON.stringify(engine)}`);
    const {offer, answer, del} = engine;
    this.offer = offer;
    this.answer = answer;
    this.del = del;

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, this.useWss);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    let proxy, uris;

    try {
      // determine where to send the call
      debug(`connecting call: ${JSON.stringify(this.req.locals)}`);
      if (this.req.locals.registration) {
        debug(`sending call to user ${JSON.stringify(this.req.locals.registration)}`);
        proxy = this.req.locals.registration.contact;
        uris = [this.req.uri];
      }
      else if (this.req.locals.target === 'forward') {
        uris = [this.req.uri];
      }
      else {
        debug('calling lcr');
        try {
          // strip leading plus sign
          const routableNumber = this.req.calledNumber.startsWith('+') ?
            this.req.calledNumber.slice(1) :
            this.req.calledNumber;
          uris = await this.performLcr(routableNumber);
          if (!uris || uris.length === 0) throw new Error('no routes found');
        } catch (err) {
          debug(err);
          this.logger.error(err, 'Error performing lcr');
          const tags = ['accepted:no', 'sipStatus:488'];
          this.stats.increment('sbc.originations', tags);
          return this.res.send(488);
        }
        debug(`sending call to PSTN ${uris}`);
      }

      // rtpengine 'offer'
      debug('sending offer command to rtpengine');
      const response = await this.offer(this.rtpEngineOpts.offer);
      debug(`response from rtpengine to offer ${JSON.stringify(response)}`);
      if ('ok' !== response.result) {
        this.logger.error(`rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      // crank through the list of gateways until connected, exhausted or caller hangs up
      let earlyMedia = false;
      while (uris.length) {
        const uri = uris.shift();
        debug(`sending INVITE to ${uri} via ${proxy})`);
        this.logger.info(`sending INVITE to ${uri}`);
        try {
          const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
            proxy,
            passFailure: false,
            proxyRequestHeaders: ['all'],
            proxyResponseHeaders: ['all'],
            headers: {
              'From': createBLegFromHeader(this.req),
              'To': createBLegToHeader(this.req)
            },
            localSdpB: response.sdp,
            localSdpA: async(sdp, res) => {
              this.toTag = res.getParsedHeader('To').params.tag;
              const opts = Object.assign({sdp, 'to-tag': this.toTag},
                this.rtpEngineOpts.answer);
              this.logger.debug({opts}, 'calling rtpengine answer with these opts');
              const response = await this.answer(opts);
              if ('ok' !== response.result) {
                this.logger.error(`rtpengine answer failed with ${JSON.stringify(response)}`);
                throw new Error('rtpengine failed: answer');
              }
              return response.sdp;
            }
          }, {
            cbProvisional: (response) => {
              if (!earlyMedia && [180, 183].includes(response.status) && response.body) earlyMedia = true;
            }
          });

          // successfully connected
          this.logger.info(`call connected to ${uri}`);
          debug('call connected');
          this.emit('connected', uri);

          this._setHandlers({uas, uac});
          return;

        } catch (err) {
          // these are all final failure scenarios
          if (uris.length === 0 ||          // exhausted all targets
            earlyMedia ||                   // failure after early media
            !(err instanceof SipError) ||   // unexpected error
            err.status === 487) {           // caller hung up

            if (err instanceof SipError) this.logger.info(`final call failure  ${err.status}`);
            else this.logger.error(err, 'unexpected call failure');
            debug(`got final outdial error: ${err}`);
            this.res.send(err.status || 500);
            this.emit('failed');
            this.rtpEngineResource.destroy();
            const tags = ['accepted:no', `sipStatus:${err.status || 500}`];
            this.stats.increment('sbc.originations', tags);
            break;
          }
          else {
            this.logger.info(`got ${err.status}, cranking back to next destination`);
          }
        }
      }
    } catch (err) {
      this.logger.error(err, `Error setting up outbonund call to: ${uris}`);
      this.emit('failed');
      this.rtpEngineResource.destroy();
    }
  }

  _setHandlers({uas, uac}) {
    this.activeCallIds.add(this.req.get('Call-ID'));
    const tags = ['accepted:yes', 'sipStatus:200'];
    this.stats.increment('sbc.originations', tags);

    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      //hangup
      dlg.on('destroy', () => {
        this.logger.info('call ended');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
      });

      //re-invite
      dlg.on('modify', this._onReinvite.bind(this, dlg));
    });

    // default forwarding of other request types
    forwardInDialogRequests(uas);
  }

  async _onReinvite(dlg, req, res) {
    try {
      const optOffer = Object.assign(this.rtpEngineOpts.offer, {sdp: req.body, 'to-tag': this.toTag});
      this.logger.debug({opts: optOffer}, 'got reinvite, calling rtpengine offer with these opts');
      let response = await this.offer(optOffer);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      this.logger.debug({sdp: response.sdp}, 'rtpengine offer returned');
      const sdp = await dlg.other.modify(response.sdp);
      this.logger.debug({sdp}, 'reinvite to feature server returned');
      const opts = Object.assign(this.rtpEngineOpts.answer, {sdp, 'to-tag': this.toTag});
      this.logger.debug({opts}, 'in reinvite, calling rtpengine answer with these opts');
      response = await this.answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      this.logger.debug({sdp: response.sdp}, 'rtpengine answer returned');
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

}

module.exports = CallSession;

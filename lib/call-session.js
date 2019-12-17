const Emitter = require('events');
const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const {makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-outbound');

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.performLcr = this.srf.locals.dbHelpers.performLcr;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.useWss = req.locals.registration && req.locals.registration.protocol === 'wss';
  }

  async connect() {
    this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, this.useWss);
    this.rtpEngineResource = {destroy: del.bind(rtpengine, this.rtpEngineOpts.common)};
    let proxy, uris;

    try {
      // determine where to send the call
      debug(`connecting call: ${JSON.stringify(this.req.locals)}`);
      if (this.req.locals.registration) {
        debug(`sending call to user ${JSON.stringify(this.req.locals.registration)}`);
        proxy = this.req.locals.registration.contact;
        uris = [this.req.uri];
      }
      else {
        debug('calling lcr');
        try {
          uris = await this.performLcr(this.req.calledNumber);
          if (!uris || uris.length === 0) throw new Error('no routes found');
        } catch (err) {
          debug(err);
          this.logger.error(err, 'Error performing lcr');
          return this.res.send(488);
        }
        debug(`sending call to PSTN ${uris}`);
      }

      // rtpengine 'offer'
      debug('sending offer command to rtpengine');
      const response = await offer(this.rtpEngineOpts.offer);
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
        this.logger.info(`sending INVITE to ${uri} via ${proxy})`);
        try {
          const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
            proxy,
            passFailure: false,
            proxyRequestHeaders: ['all'],
            proxyResponseHeaders: ['all'],
            localSdpB: response.sdp,
            localSdpA: async(sdp, res) => {
              const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
                this.rtpEngineOpts.answer);
              const response = await answer(opts);
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
            this.emit('failed');
            this.rtpEngineResource.destroy();
            break;
          }
          else {
            debug(`got ${err.status}, cranking back to next destination`);
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
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      //hangup
      dlg.on('destroy', () => {
        this.logger.info('call ended');
        this.rtpEngineResource.destroy();
      });

      //re-invite
      dlg.on('modify', this._onReinvite.bind(this, dlg));
    });

    // default forwarding of other request types
    forwardInDialogRequests(uas);
  }

  async _onReinvite(dlg, req, res) {
    try {
      let response = await offer(Object.assign({sdp: req.body}, this.rtpEngineOpts.offer));
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      const sdp = await dlg.other.modify(response.sdp);
      const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
        this.rtpEngineOpts.answer);
      response = await answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

}

module.exports = CallSession;

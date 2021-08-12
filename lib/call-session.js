const Emitter = require('events');
const {makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError} = require('drachtio-srf');
const {parseUri, stringifyUri} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-outbound');

const makeInviteInProgressKey = (callid) => `sbc-out-iip${callid}`;
/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req, teams) => {
  const from = req.getParsedHeader('From');
  const host = teams ? req.get('X-MS-Teams-Tenant-FQDN') : 'localhost';
  const uri = parseUri(from.uri);
  if (uri && uri.user) return `sip:${uri.user}@${host}`;
  return `sip:anonymous@${host}`;
};
const createBLegToHeader = (req, teams) => {
  const to = req.getParsedHeader('To');
  const host = teams ? req.get('X-MS-Teams-Tenant-FQDN') : 'localhost';
  const uri = parseUri(to.uri);
  if (uri && uri.user) return `sip:${uri.user}@${host}`;
  return `sip:anonymous@${host}`;
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
    const teams = this.teams = this.req.locals.target === 'teams';
    const engine = this.srf.locals.getRtpEngine();
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      const tags = ['accepted:no', 'sipStatus:408'];
      this.stats.increment('sbc.originations', tags);
      return this.res.send(480);
    }
    debug(`got engine: ${JSON.stringify(engine)}`);
    const {offer, answer, del} = engine;
    const {createHash, retrieveHash} = this.srf.locals.realtimeDbHelpers;
    this.offer = offer;
    this.answer = answer;
    this.del = del;

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, this.useWss || teams, teams);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    let proxy, uris;
    const mapGateways = new Map();

    try {
      // determine where to send the call
      debug(`connecting call: ${JSON.stringify(this.req.locals)}`);
      const headers = {
        'From': createBLegFromHeader(this.req, teams),
        'To': createBLegToHeader(this.req, teams),
        Allow: 'INVITE, ACK, OPTIONS, CANCEL, BYE, NOTIFY, UPDATE, PRACK'
      };

      if (this.req.locals.registration) {
        debug(`sending call to registered user ${JSON.stringify(this.req.locals.registration)}`);
        const contact = this.req.locals.registration.contact;
        let destUri = this.req.uri;
        if (this.req.has('X-Override-To')) {
          const dest = this.req.get('X-Override-To');
          const uri = parseUri(contact);
          uri.user = dest;
          destUri = stringifyUri(uri);
          this.logger.info(`overriding destination user with ${dest}, so final uri is ${destUri}`);
        }
        if (contact.includes('transport=ws')) {
          uris = [contact];
        }
        else {
          proxy = this.req.locals.registration.proxy;
          uris = [destUri];
        }
      }
      else if (this.req.locals.target === 'forward') {
        uris = [this.req.uri];
      }
      else if (teams) {
        const vmailParam = 'opaque=app:voicemail';
        proxy = `sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com:5061;transport=tls`;
        if (this.req.uri.includes(vmailParam)) {
          uris = [`sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com;${vmailParam}`];
        }
        else uris = [`sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com`];
        Object.assign(headers, {
          Contact: `sip:${this.req.calledNumber}@${this.req.get('X-MS-Teams-Tenant-FQDN')}:5061;transport=tls`
        });
      }
      else {
        debug('calling lcr');
        try {
          /**
           * We normalize the called number by removing a leading + before sending it to LCR..
           * but LCR will return us an array of sip uris, with leading + for carriers that require it
           */
          const routableNumber = this.req.calledNumber.startsWith('+') ?
            this.req.calledNumber.slice(1) :
            this.req.calledNumber;
          //uris = await this.performLcr(routableNumber);
          const gateways = await this.performLcr(routableNumber);
          if (!gateways || gateways.length === 0) throw new Error('no routes found');
          debug(`got gateways: ${JSON.stringify(gateways)}`);
          gateways.forEach((gw) => mapGateways.set(gw.uri, gw.auth));
          uris = gateways.map((gw) => gw.uri);
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
      const opts = {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  ['private', 'public'],
        sdp: this.req.body
      };
      const response = await this.offer(opts);
      debug(`response from rtpengine to offer ${JSON.stringify(response)}`);
      this.logger.debug({offer: opts, response}, 'initial offer to rtpengine');
      if ('ok' !== response.result) {
        this.logger.error(`rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      // crank through the list of gateways until connected, exhausted or caller hangs up
      let earlyMedia = false;
      while (uris.length) {
        const hdrs = { ...headers};
        const uri = uris.shift();
        const auth = mapGateways.get(uri);
        const passFailure = 0 === uris.length;  // only a single target
        if (0 === uris.length) {
          try {
            const key = makeInviteInProgressKey(this.req.get('Call-ID'));
            const obj = await retrieveHash(key);
            if (obj && obj.callId && obj.cseq) {
              Object.assign(hdrs, {
                'Call-ID': obj.callId,
                'CSeq': `${obj.cseq} INVITE`
              });
            }
          } catch (err) {
            this.logger.info({err}, 'Error retrieving iip key');
          }
        }
        debug(`sending INVITE to ${uri} via ${proxy})`);
        this.logger.info(`sending INVITE to ${uri}`);
        try {
          const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
            proxy,
            passFailure,
            proxyRequestHeaders: ['all', '-X-MS-Teams-FQDN', '-X-MS-Teams-Tenant-FQDN', 'X-CID', '-Allow',
              '-X-Account-Sid', '-Session-Expires', 'Min-SE'],
            proxyResponseHeaders: ['all', '-Allow', '-Session-Expires'],
            headers: hdrs,
            auth,
            localSdpB: response.sdp,
            localSdpA: async(sdp, res) => {
              this.rtpEngineOpts.uac.tag = res.getParsedHeader('To').params.tag;
              const opts = {
                ...this.rtpEngineOpts.common,
                ...this.rtpEngineOpts.uas.mediaOpts,
                'from-tag': this.rtpEngineOpts.uas.tag,
                'to-tag': this.rtpEngineOpts.uac.tag,
                flags: ['single codec'],
                sdp
              };
              const response = await this.answer(opts);
              this.logger.debug({answer: opts, response}, 'rtpengine answer');
              if ('ok' !== response.result) {
                this.logger.error(`rtpengine answer failed with ${JSON.stringify(response)}`);
                throw new Error('rtpengine failed: answer');
              }
              return response.sdp;
            }
          }, {
            cbRequest: async(err, inv) => {
              const opts = {
                callId: inv.get('Call-ID'),
                cseq: ++inv.getParsedHeader('CSeq').seq
              };
              try {
                const key = makeInviteInProgressKey(this.req.get('Call-ID'));
                await createHash(key, opts, 5);
              } catch (err) {
                this.logger.error({err}, 'Error saving Call-ID/CSeq');
              }
            },
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
            if (!passFailure) this.res.send(err.status || 500);
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
        dlg.other.destroy();
      });
    });

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uas.on('refer', this._onFeatureServerTransfer.bind(this, uas));


    // default forwarding of other request types
    forwardInDialogRequests(uac,  ['info', 'notify', 'options', 'message']);
  }

  async _onReinvite(dlg, req, res) {
    try {
      const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
      const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
      const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
      const answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
      const direction =  dlg.type === 'uas' ? ['private', 'public'] : ['public', 'private'];
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: req.body,
      };

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      const sdp = await dlg.other.modify(response.sdp);
      opts = {
        ...this.rtpEngineOpts.common,
        ...answerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp
      };
      response = await this.answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  async _onFeatureServerTransfer(dlg, req, res) {
    try {
      const referTo = req.getParsedHeader('Refer-To');
      const uri = parseUri(referTo.uri);
      this.logger.info({uri, referTo}, 'received REFER from feature server');
      const arr = /context-(.*)/.exec(uri.user);
      if (!arr) {
        this.logger.info(`invalid Refer-To header: ${referTo.uri}`);
        return res.send(501);
      }
      res.send(202);

      // invite to new fs
      const headers = {};
      if (req.has('X-Retain-Call-Sid')) {
        Object.assign(headers, {'X-Retain-Call-Sid': req.get('X-Retain-Call-Sid')});
      }
      const uas = await this.srf.createUAC(referTo.uri, {localSdp: dlg.local.sdp, headers});
      this.uas = uas;
      uas.other = this.uac;
      this.uac.other = uas;
      uas.on('modify', this._onReinvite.bind(this, uas));
      uas.on('refer', this._onFeatureServerTransfer.bind(this, uas));
      uas.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        uas.other.destroy();
      });

      // now we can destroy the old dialog
      dlg.destroy();

      // modify rtpengine to stream to new feature server
      // NB: the media handover flag should suffice to tell rtpengine to relearn addresses
      /*
      let response = await this.offer(Object.assign(this.rtpEngineOpts.offer, {sdp: this.uas.remote.sdp}));
      if ('ok' !== response.result) {
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      const sdp = await this.uas.other.modify(response.sdp);
      const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
        this.rtpEngineOpts.answer);
      response = await this.answer(opts);
      if ('ok' !== response.result) {
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      */
      this.logger.info('successfully moved call to new feature server');
    } catch (err) {
      this.logger.error(err, 'Error handling refer from feature server');
    }
  }
}

module.exports = CallSession;

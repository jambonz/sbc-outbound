const Emitter = require('events');
const sdpTransform = require('sdp-transform');
const SrsClient = require('@jambonz/siprec-client-utils');
const {makeRtpEngineOpts, nudgeCallCounts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError, stringifyUri, parseUri} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-outbound');

const makeInviteInProgressKey = (callid) => `sbc-out-iip${callid}`;
/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req, teams) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  let user = uri.user || 'anonymous';
  let host = 'localhost';
  if (teams) {
    host = req.get('X-MS-Teams-Tenant-FQDN');
  }
  else if (req.has('X-Preferred-From-User') || req.has('X-Preferred-From-Host')) {
    user = req.get('X-Preferred-From-User') || user;
    host = req.get('X-Preferred-From-Host') || host;
  }
  return `sip:${user}@${host}`;
};
const createBLegToHeader = (req, teams) => {
  const to = req.getParsedHeader('To');
  const host = teams ? req.get('X-MS-Teams-Tenant-FQDN') : 'localhost';
  const uri = parseUri(to.uri);
  if (uri && uri.user) return `sip:${uri.user}@${host}`;
  return `sip:anonymous@${host}`;
};

const initCdr = (srf, req) => {
  const uri = parseUri(req.uri);
  const regex = /^\+(\d+)$/;
  let arr = regex.exec(req.calledNumber);
  const to = arr ? arr[1] : req.calledNumber;
  arr = regex.exec(req.callingNumber);
  const from = arr ? arr[1] : req.callingNumber;

  return {
    account_sid: req.get('X-Account-Sid'),
    call_sid: req.get('X-Call-Sid'),
    sip_callid: req.get('Call-ID'),
    from,
    to,
    duration: 0,
    answered: false,
    attempted_at: Date.now(),
    direction: 'outbound',
    host: srf.locals.sipAddress,
    remote_host: uri.host,
    trace_id: req.get('X-Trace-ID') || '00000000000000000000000000000000'
  };
};

const updateRtpEngineFlags = (sdp, opts) => {
  try {
    const parsed = sdpTransform.parse(sdp);
    const codec = parsed.media[0].rtp[0].codec;
    if (['PCMU', 'PCMA'].includes(codec)) opts.flags.push(`codec-accept-${codec}`);
  } catch (err) {}
  return opts;
};

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.useWss = req.locals.registration && req.locals.registration.protocol === 'wss';
    this.stats = this.srf.locals.stats;
    this.activeCallIds = this.srf.locals.activeCallIds;
    this.writeCdrs = this.srf.locals.writeCdrs;

    this.decrKey = req.srf.locals.realtimeDbHelpers.decrKey;

    const {performLcr, lookupCarrierBySid, lookupSipGatewaysByCarrier} = this.srf.locals.dbHelpers;
    this.performLcr = performLcr;
    this.lookupCarrierBySid = lookupCarrierBySid;
    this.lookupSipGatewaysByCarrier = lookupSipGatewaysByCarrier;

    this._mediaReleased = false;
  }

  get account_sid() {
    return this.req.locals.account_sid;
  }

  get application_sid() {
    return this.req.locals.application_sid;
  }

  get privateSipAddress() {
    return this.srf.locals.privateSipAddress;
  }

  get isMediaReleased() {
    return this._mediaReleased;
  }

  async connect() {
    const teams = this.teams = this.req.locals.target === 'teams';
    const engine = this.srf.locals.getRtpEngine();
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      return this.res.send(480);
    }
    debug(`got engine: ${JSON.stringify(engine)}`);
    const {
      offer,
      answer,
      del,
      blockMedia,
      unblockMedia,
      blockDTMF,
      unblockDTMF,
      playDTMF,
      subscribeDTMF,
      unsubscribeDTMF,
      subscribeRequest,
      subscribeAnswer,
      unsubscribe
    } = engine;
    const {createHash, retrieveHash} = this.srf.locals.realtimeDbHelpers;
    this.offer = offer;
    this.answer = answer;
    this.del = del;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.blockDTMF = blockDTMF;
    this.unblockDTMF = unblockDTMF;
    this.playDTMF = playDTMF;
    this.subscribeDTMF = subscribeDTMF;
    this.unsubscribeDTMF = unsubscribeDTMF;
    this.subscribeRequest = subscribeRequest;
    this.subscribeAnswer = subscribeAnswer;
    this.unsubscribe = unsubscribe;

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, this.useWss || teams, teams);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    let proxy, uris;
    const mapGateways = new Map();

    try {
      // determine where to send the call
      debug(`connecting call: ${JSON.stringify(this.req.locals)}`);
      let headers = {
        'From': createBLegFromHeader(this.req, teams),
        'Contact': createBLegFromHeader(this.req, teams),
        'To': createBLegToHeader(this.req, teams),
        Allow: 'INVITE, ACK, OPTIONS, CANCEL, BYE, NOTIFY, UPDATE, PRACK',
        'X-Account-Sid': this.account_sid
      };

      if (this.req.locals.registration) {
        debug(`sending call to registered user ${JSON.stringify(this.req.locals.registration)}`);
        const contact = this.req.locals.registration.contact;
        let destUri = contact;
        if (this.req.has('X-Override-To')) {
          const dest = this.req.get('X-Override-To');
          const uri = parseUri(contact);
          uri.user = dest;
          destUri = stringifyUri(uri);
          this.logger.info(`overriding destination user with ${dest}, so final uri is ${destUri}`);
        }
        uris = [destUri];
        if (!contact.includes('transport=ws')) {
          proxy = this.req.locals.registration.proxy;
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
        headers = {
          ...headers,
          Contact: `sip:${this.req.calledNumber}@${this.req.get('X-MS-Teams-Tenant-FQDN')}:5061;transport=tls`
        };
      }
      else {
        debug('calling lcr');
        try {
          /* was a specific carrier requested */
          const voip_carrier_sid = this.req.get('X-Requested-Carrier-Sid');
          if (voip_carrier_sid) {
            const vc = await this.lookupCarrierBySid(voip_carrier_sid);
            const gateways = await this.lookupSipGatewaysByCarrier(voip_carrier_sid);
            const gws = (gateways || [])
              .filter((gw) => gw.outbound);
            if (gws.length) {
              uris = [];
              gws.forEach((o) => {
                const prefix = vc.tech_prefix;
                const hostport = !o.port || 5060 === o.port ? o.ipv4 : `${o.ipv4}:${o.port}`;
                const prependPlus = vc.e164_leading_plus && !this.req.calledNumber.startsWith('0');
                const u = `sip:${prefix ? prefix : ''}${prependPlus ? '+' : ''}${this.req.calledNumber}@${hostport}`;
                const obj = {
                  name: vc.name,
                  diversion: vc.diversion,
                  hostport
                };
                if (vc.register_username && vc.register_password) {
                  obj.auth = {
                    username: vc.register_username,
                    password: vc.register_password
                  };
                }
                mapGateways.set(u, obj);
                uris.push(u);
              });
              this.logger.debug({uris, voip_carrier_sid}, 'selected outbound gateways for requested carrier');
            }
            else {
              this.logger.info({voip_carrier_sid}, 'no outbound gateways found for requested carrier');
            }
          }
          if (mapGateways.size === 0) {
            /**
             * We normalize the called number by removing a leading + before sending it to LCR..
             * but LCR will return us an array of sip uris, with leading + for carriers that require it
             */
            const routableNumber = this.req.calledNumber.startsWith('+') ?
              this.req.calledNumber.slice(1) :
              this.req.calledNumber;
            const gateways = await this.performLcr(routableNumber, this.account_sid);
            if (!gateways || gateways.length === 0) throw new Error('no routes found');
            debug(`got gateways: ${JSON.stringify(gateways)}`);
            gateways.forEach((gw) => mapGateways.set(gw.uri, {
              name: gw.name,
              auth: gw.auth,
              diversion: gw.diversion,
              hostport: gw.hostport
            }));
            uris = gateways.map((gw) => gw.uri);
          }
        } catch (err) {
          debug(err);
          this.logger.error(err, 'Error performing lcr');
          this.res.send(488);
          return this.srf.endSession(this.req);
        }
        debug(`sending call to PSTN ${uris}`);
      }

      // rtpengine 'offer'
      const opts = updateRtpEngineFlags(this.req.body, {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  ['private', 'public'],
        sdp: this.req.body
      });
      const response = await this.offer(opts);
      debug(`response from rtpengine to offer ${JSON.stringify(response)}`);
      this.logger.debug({offer: opts, response}, 'initial offer to rtpengine');
      if ('ok' !== response.result) {
        this.logger.error(`rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      /* check if call was abandoned */
      if (this.req.canceled) throw new Error('abandoned');

      // crank through the list of gateways until connected, exhausted or caller hangs up
      let earlyMedia = false;
      while (uris.length) {
        let hdrs = { ...headers};
        const uri = uris.shift();
        const gw = mapGateways.get(uri);
        const passFailure = 0 === uris.length;  // only a single target
        if (0 === uris.length) {
          try {
            const key = makeInviteInProgressKey(this.req.get('Call-ID'));
            const obj = await retrieveHash(key);
            if (obj && obj.callId && obj.cseq) {
              hdrs = {
                ...hdrs,
                'Call-ID': obj.callId,
                'CSeq': `${obj.cseq} INVITE`
              };
            }
          } catch (err) {
            this.logger.info({err}, 'Error retrieving iip key');
          }
        }
        if (gw) {
          this.logger.info({gw}, `sending INVITE to ${uri} via carrier ${gw.name}`);
          hdrs = {...hdrs, 'To': uri};
          if (gw.diversion) {
            let div = gw.diversion;
            if (div.startsWith('+')) {
              div = `<sip:${div}@${gw.hostport}>;reason=unknown;counter=1;privacy=off`;
            }
            else div = `<sip:+${div}@${gw.hostport}>;reason=unknown;counter=1;privacy=off`;
            hdrs = {
              ...hdrs,
              'Diversion': div
            };
          }
        }
        else this.logger.info(`sending INVITE to ${uri} via proxy ${proxy})`);
        try {
          const responseHeaders = this.privateSipAddress ? {Contact: `<sip:${this.privateSipAddress}>`} : {};

          const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
            proxy,
            passFailure,
            proxyRequestHeaders: [
              'all',
              '-X-MS-Teams-FQDN',
              '-X-MS-Teams-Tenant-FQDN',
              '-X-Trace-ID',
              '-Allow',
              '-Session-Expires',
              '-X-Requested-Carrier-Sid',
              '-X-Jambonz-Routing',
              '-X-Jambonz-FS-UUID',
              '-X-Preferred-From-User',
              'X-Preferred-From-Host',
              '-X-Jambonz-FS-UUID',
            ],
            proxyResponseHeaders: [
              'all',
              '-Allow',
              '-Session-Expires'
            ],
            headers: hdrs,
            responseHeaders,
            auth: gw ? gw.auth : undefined,
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
                /* note: this can happen if call was abandoned while we were waiting for B leg to answer */
                this.logger.info(`rtpengine answer failed with ${JSON.stringify(response)}`);
                throw new Error(`rtpengine failed: ${response['error-reason']}`);
              }
              return response.sdp;
            }
          }, {
            cbRequest: async(err, inv) => {
              if (err) return this.logger.info({err}, 'CallSession error sending INVITE');
              let trunk = gw ? gw.name : null;
              if (!trunk) {
                if (teams) trunk = 'Microsoft Teams';
                else if (this.req.locals.registration) trunk = 'user';
                else trunk = 'sipUri';
              }
              if (!this.req.locals.account.disable_cdrs) {
                this.req.locals.cdr = {
                  ...initCdr(this.req.srf, inv),
                  service_provider_sid: this.req.locals.service_provider_sid,
                  account_sid: this.req.locals.account_sid,
                  ...(this.req.locals.application_sid && {application_sid: this.req.locals.application_sid}),
                  trunk
                };
              }
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
          this.connectedUri = uri;
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

            const abandoned = err.message && err.message.includes('rtpengine failed: Unknown call-id');
            const status = err.status || (abandoned ? 487 : 500);
            if (err instanceof SipError) this.logger.info(`final call failure  ${status}`);
            else if (!abandoned) this.logger.error(err, 'unexpected call failure');
            debug(`got final outdial error: ${err}`);
            if (!passFailure) this.res.send(status);
            this.emit('failed');
            this.rtpEngineResource.destroy()
              .catch((err) => this.logger.info({err}, 'Error destroying rtpe after failure'));
            this.srf.endSession(this.req);
            const tags = ['accepted:no', `sipStatus:${status}`];
            this.stats.increment('sbc.originations', tags);

            if (this.req.locals.cdr && ![401, 407].includes(status)) {
              this.writeCdrs({...this.req.locals.cdr,
                terminated_at: Date.now(),
                termination_reason: 487 === status ? 'caller abandoned' : 'failed',
                sip_status: status
              }).catch((err) => this.logger.error({err}, 'Error writing cdr for call failure'));
            }
          }
          else {
            this.logger.info(`got ${err.status}, cranking back to next destination`);
          }
        }
      }
    } catch (err) {
      if ('abandonded' !== err.message) this.logger.error(err, `Error setting up outbound call to: ${uris}`);
      this.emit('failed');
      this.srf.endSession(this.req);
      this.rtpEngineResource.destroy();
    }
  }

  _setHandlers({uas, uac}) {
    const callStart = Date.now();
    const tags = ['accepted:yes', 'sipStatus:200'];
    this.stats.increment('sbc.originations', tags);
    this.activeCallIds.set(this.req.get('Call-ID'), this);
    if (this.req.locals.cdr) {
      this.req.locals.cdr = {
        ...this.req.locals.cdr,
        answered: true,
        answered_at: callStart
      };
    }
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      dlg.on('destroy', async() => {
        const other = dlg.other;
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag);
        try {
          await other.destroy();
        } catch (err) {}

        const trackingOn = process.env.JAMBONES_TRACK_ACCOUNT_CALLS ||
          process.env.JAMBONES_TRACK_SP_CALLS ||
          process.env.JAMBONES_TRACK_APP_CALLS;

        if (process.env.JAMBONES_HOSTING || trackingOn) {
          const {writeCallCount, writeCallCountSP, writeCallCountApp} = this.req.srf.locals;
          await nudgeCallCounts(this.logger, {
            service_provider_sid: this.service_provider_sid,
            account_sid: this.account_sid,
            application_sid: this.application_sid
          }, this.decrKey, {writeCallCountSP, writeCallCount, writeCallCountApp})
            .catch((err) => this.logger.error(err, 'Error decrementing call counts'));
        }

        /* write cdr for connected call */
        if (this.req.locals.cdr) {
          const now = Date.now();
          this.writeCdrs({...this.req.locals.cdr,
            terminated_at: now,
            termination_reason: dlg.type === 'uas' ? 'caller hungup' : 'called party hungup',
            sip_status: 200,
            answered: true,
            duration: Math.floor((now - callStart) / 1000)
          }).catch((err) => this.logger.error({err}, 'Error writing cdr for completed call'));
        }
        /* de-link the 2 Dialogs for GC */
        dlg.removeAllListeners();
        other.removeAllListeners();
        dlg.other = null;
        other.other = null;

        this.logger.info(`call ended with normal termination, there are ${this.activeCallIds.size} active`);

        this.srf.endSession(this.req);
      });
    });

    this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag,
      this._onDTMF.bind(this, uas));

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uas.on('refer', this._onFeatureServerTransfer.bind(this, uas));
    uac.on('refer', this._onRefer.bind(this, uac));

    uas.on('info', this._onInfo.bind(this, uas));
    uac.on('info', this._onInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uac,  ['notify', 'options', 'message']);
  }

  async _onRefer(dlg, req, res) {
    /* REFER coming in from a sip device, forward to feature server */
    try {
      const response = await dlg.other.request({
        method: 'REFER',
        headers: {
          'Refer-To': req.get('Refer-To'),
          'Referred-By': req.get('Referred-By'),
          'User-Agent': req.get('User-Agent')
        }
      });
      res.send(response.status, response.reason);
    } catch (err) {
      this.logger.error({err}, 'CallSession:_onRefer: error handling incoming REFER');
    }
  }

  async _onDTMF(dlg, payload) {
    this.logger.info({payload}, '_onDTMF');
    try {
      let dtmf;
      switch (payload.event) {
        case 10:
          dtmf = '*';
          break;
        case 11:
          dtmf = '#';
          break;
        default:
          dtmf = '' + payload.event;
          break;
      }
      await dlg.request({
        method: 'INFO',
        headers: {
          'Content-Type': 'application/dtmf-relay'
        },
        body: `Signal=${dtmf}
Duration=${payload.duration} `
      });
    } catch (err) {
      this.logger.info({err}, 'Error sending INFO application/dtmf-relay');
    }
  }

  async _onReinvite(dlg, req, res) {
    try {
      const reason = req.get('X-Reason');
      const isReleasingMedia = reason && dlg.type === 'uas' && ['release-media', 'anchor-media'].includes(reason);
      const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
      const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
      const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
      const answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
      const direction =  dlg.type === 'uas' ? ['private', 'public'] : ['public', 'private'];
      if (isReleasingMedia) {
        if (!offerMedia.flags.includes('port latching')) offerMedia.flags.push('port latching');
        if (!offerMedia.flags.includes('asymmetric')) offerMedia.flags.push('asymmetric');
        offerMedia.flags = offerMedia.flags.filter((f) => f !== 'media handover');
      }
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: req.body,
      };
      if (reason && opts.flags && !opts.flags.includes('reset')) opts.flags.push('reset');

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      this.logger.debug({opts, response}, 'CallSession:_onReinvite: (offer)');

      /* if this is a re-invite from the FS to change media anchoring, avoid sending the reinvite out */
      let sdp;
      if (isReleasingMedia) {
        this.logger.info(`got a reinvite from FS to ${reason}`);
        sdp = dlg.other.remote.sdp;
        if (!answerMedia.flags.includes('port latching')) answerMedia.flags.push('port latching');
        if (!answerMedia.flags.includes('asymmetric')) answerMedia.flags.push('asymmetric');
        answerMedia.flags = answerMedia.flags.filter((f) => f !== 'media handover');
        this._mediaReleased = 'release-media' === reason;
      }
      else {
        sdp = await dlg.other.modify(response.sdp);
        this.logger.info({sdp}, 'CallSession:_onReinvite: got sdp from 200 OK to invite we sent');
      }
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
      this.logger.debug({opts, sdp: response.sdp}, 'CallSession:_onReinvite: (answer) sending back upstream');
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  async _onInfo(dlg, req, res) {
    try {
      const contentType = req.get('Content-Type');
      if (dlg.type === 'uas' && req.has('X-Reason')) {
        const toTag = this.rtpEngineOpts.uac.tag;
        const reason = req.get('X-Reason');
        const opts = {
          ...this.rtpEngineOpts.common,
          'from-tag': toTag
        };
        this.logger.info(`_onInfo: got request ${reason}`);
        res.send(200);

        if (reason.startsWith('mute')) {
          const response = Promise.all([this.blockMedia(opts), this.blockDTMF(opts)]);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
        else if (reason.startsWith('unmute')) {
          const response = Promise.all([this.unblockMedia(opts), this.unblockDTMF(opts)]);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
        else if (reason.includes('CallRecording')) {
          let succeeded = false;
          if (reason === 'startCallRecording') {
            const from = this.req.getParsedHeader('From');
            const to = this.req.getParsedHeader('To');
            const aorFrom = from.uri;
            const aorTo = to.uri;
            this.logger.info({to, from}, 'startCallRecording request for an outbound call');

            const srsUrl = req.get('X-Srs-Url');
            const srsRecordingId = req.get('X-Srs-Recording-ID');
            const callSid = req.get('X-Call-Sid');
            const accountSid = req.get('X-Account-Sid');
            const applicationSid = req.get('X-Application-Sid');
            if (this.srsClient) {
              res.send(400);
              this.logger.info('discarding duplicate startCallRecording request for a call');
              return;
            }
            if (!srsUrl) {
              this.logger.info('startCallRecording request is missing X-Srs-Url header');
              res.send(400);
              return;
            }
            this.srsClient = new SrsClient(this.logger, {
              srf: dlg.srf,
              direction: 'outbound',
              originalInvite: this.req,
              callingNumber: this.req.callingNumber,
              calledNumber: this.req.calledNumber,
              srsUrl,
              srsRecordingId,
              callSid,
              accountSid,
              applicationSid,
              rtpEngineOpts: this.rtpEngineOpts,
              toTag,
              aorFrom,
              aorTo,
              subscribeRequest: this.subscribeRequest,
              subscribeAnswer: this.subscribeAnswer,
              del: this.del,
              blockMedia: this.blockMedia,
              unblockMedia: this.unblockMedia,
              unsubscribe: this.unsubscribe
            });
            try {
              succeeded = await this.srsClient.start();
            } catch (err) {
              this.logger.error({err}, 'Error starting SipRec call recording');
            }
          }
          else if (reason === 'stopCallRecording') {
            if (!this.srsClient) {
              res.send(400);
              this.logger.info('discarding stopCallRecording request because we are not recording');
              return;
            }
            try {
              succeeded = await this.srsClient.stop();
            } catch (err) {
              this.logger.error({err}, 'Error stopping SipRec call recording');
            }
            this.srsClient = null;
          }
          else if (reason === 'pauseCallRecording') {
            if (!this.srsClient || this.srsClient.paused) {
              this.logger.info('discarding invalid pauseCallRecording request');
              res.send(400);
              return;
            }
            succeeded = await this.srsClient.pause();
          }
          else if (reason === 'resumeCallRecording') {
            if (!this.srsClient || !this.srsClient.paused) {
              res.send(400);
              this.logger.info('discarding invalid resumeCallRecording request');
              return;
            }
            succeeded = await this.srsClient.resume();
          }
          res.send(succeeded ? 200 : 503);
        }
      }
      else if (dlg.type === 'uac' && ['application/dtmf-relay', 'application/dtmf'].includes(contentType)) {
        const arr = /Signal=\s*([1-9#*])/.exec(req.body);
        if (!arr) {
          this.logger.info({body: req.body}, '_onInfo: invalid INFO dtmf request');
          throw new Error(`_onInfo: no dtmf in body for ${contentType}`);
        }
        const code = arr[1];
        const arr2 = /Duration=\s*(\d+)/.exec(req.body);
        const duration = arr2 ? arr2[1] : 250;

        if (this.isMediaReleased) {
          /* just relay on to the feature server */
          this.logger.info({code, duration}, 'got SIP INFO DTMF from caller, relaying to feature server');
          this._onDTMF(dlg.other, {event: code, duration})
            .catch((err) => this.logger.info({err}, 'Error relaying DTMF to feature server'));
          res.send(200);
        }
        else {
          /* else convert SIP INFO to RFC 2833 telephony events */
          this.logger.info({code, duration}, 'got SIP INFO DTMF from caller, converting to RFC 2833');
          const opts = {
            ...this.rtpEngineOpts.common,
            'from-tag': this.rtpEngineOpts.uac.tag,
            code,
            duration
          };
          const response = await this.playDTMF(opts);
          if ('ok' !== response.result) {
            this.logger.info({response}, `rtpengine playDTMF failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
          res.send(200);
        }
      }
      else {
        const response = await dlg.other.request({
          method: 'INFO',
          headers: req.headers,
          body: req.body
        });
        res.send(response.status, {
          headers: response.headers,
          body: response.body
        });
      }
    } catch (err) {
      this.logger.info({err}, `Error handing INFO request on ${dlg.type} leg`);
    }
  }

  async _onFeatureServerTransfer(dlg, req, res) {
    try {
      const referTo = req.getParsedHeader('Refer-To');
      const uri = parseUri(referTo.uri);
      this.logger.info({uri, referTo}, 'received REFER from feature server');
      const arr = /context-(.*)/.exec(uri.user);
      if (!arr) {
        /* call transfer requested */
        const referredBy = req.getParsedHeader('Referred-By');
        if (!referredBy) return res.send(400);
        const u = parseUri(referredBy.uri);
        const farEnd = parseUri(this.connectedUri);
        uri.host = farEnd.host;
        uri.port = farEnd.port;

        const response = await this.uac.request({
          method: 'REFER',
          headers: {
            'Refer-To': stringifyUri(uri),
            'Referred-By': stringifyUri(u)
          }
        });
        return res.send(response.status);
      }
      res.send(202);

      // invite to new fs
      const headers = {
        ...(req.has('X-Retain-Call-Sid') && {'X-Retain-Call-Sid': req.get('X-Retain-Call-Sid')}),
        ...(req.has('X-Account-Sid') && {'X-Account-Sid': req.get('X-Account-Sid')})
      };
      const dlg = await this.srf.createUAC(referTo.uri, {localSdp: dlg.local.sdp, headers});
      this.uas = dlg;
      this.uas.other = this.uac;
      this.uac.other = this.uas;
      this.uas.on('modify', this._onReinvite.bind(this, this.uas));
      this.uas.on('refer', this._onFeatureServerTransfer.bind(this, this.uas));
      this.uas.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        this.uas.other.destroy();
        this.srf.endSession(this.req);
      });

      // modify rtpengine to stream to new feature server
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
      this.logger.info('successfully moved call to new feature server');
    } catch (err) {
      this.logger.error(err, 'Error handling refer from feature server');
    }
  }
}

module.exports = CallSession;

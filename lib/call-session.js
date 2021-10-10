const Emitter = require('events');
const {makeRtpEngineOpts, makeCallCountKey} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError} = require('drachtio-srf');
const {parseUri} = require('drachtio-srf');
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
    remote_host: uri.host
  };
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
    this.writeCdrs = this.srf.locals.writeCdrs;

    this.incrKey = req.srf.locals.realtimeDbHelpers.incrKey;
    this.decrKey = req.srf.locals.realtimeDbHelpers.decrKey;
    this.callCountKey = makeCallCountKey(req.locals.account_sid);
  }

  get account_sid() {
    return this.req.locals.account_sid;
  }

  async connect() {
    const teams = this.teams = this.req.locals.target === 'teams';
    const engine = this.srf.locals.getRtpEngine();
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      return this.res.send(480);
    }
    debug(`got engine: ${JSON.stringify(engine)}`);
    const {offer, answer, del, blockMedia, unblockMedia, blockDTMF, unblockDTMF} = engine;
    const {createHash, retrieveHash} = this.srf.locals.realtimeDbHelpers;
    this.offer = offer;
    this.answer = answer;
    this.del = del;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.blockDTMF = blockDTMF;
    this.unblockDTMF = unblockDTMF;

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
        debug(`sending call to user ${JSON.stringify(this.req.locals.registration)}`);
        const contact = this.req.locals.registration.contact;
        if (contact.includes('transport=ws')) {
          uris = [contact];
        }
        else {
          proxy = this.req.locals.registration.proxy;
          uris = [this.req.uri];
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
        } catch (err) {
          debug(err);
          this.logger.error(err, 'Error performing lcr');
          return this.res.send(488);
        }
        debug(`sending call to PSTN ${uris}`);
      }

      // rtpengine 'offer'
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
          const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
            proxy,
            passFailure,
            proxyRequestHeaders: ['all', '-X-MS-Teams-FQDN', '-X-MS-Teams-Tenant-FQDN', 'X-CID', '-Allow',
              '-Session-Expires', 'Min-SE'],
            proxyResponseHeaders: ['all', '-Allow', '-Session-Expires'],
            headers: hdrs,
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
              let trunk = gw ? gw.name : null;
              if (!trunk) {
                if (teams) trunk = 'Microsoft Teams';
                else if (this.req.locals.registration) trunk = 'user';
                else trunk = 'sipUri';
              }
              if (!this.req.locals.account.disable_cdrs) {
                this.req.locals.cdr = {
                  ...initCdr(this.req.srf, inv),
                  account_sid: this.req.locals.account_sid,
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

            const abandoned = err.message.includes('rtpengine failed: Unknown call-id');
            const status = err.status || (abandoned ? 487 : 500);
            if (err instanceof SipError) this.logger.info(`final call failure  ${status}`);
            else if (!abandoned) this.logger.error(err, 'unexpected call failure');
            debug(`got final outdial error: ${err}`);
            if (!passFailure) this.res.send(status);
            this.emit('failed');
            this.rtpEngineResource.destroy();
            const tags = ['accepted:no', `sipStatus:${status}`];
            this.stats.increment('sbc.originations', tags);

            if (this.req.locals.cdr && ![401, 407].includes(status)) {
              this.writeCdrs({...this.req.locals.cdr,
                terminated_at: Date.now(),
                termination_reason: 487 === status ? 'caller abandoned' : 'failed',
                sip_status: status,
              }).catch((err) => this.logger.error({err}, 'Error writing cdr for call failure'));
            }
          }
          else {
            this.logger.info(`got ${err.status}, cranking back to next destination`);
          }
        }
      }
    } catch (err) {
      if ('abandonded' !== err.message) this.logger.error(err, `Error setting up outbonund call to: ${uris}`);
      this.emit('failed');
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
      dlg.on('destroy', () => {
        this.logger.info('call ended');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        dlg.other.destroy();

        this.decrKey(this.callCountKey)
          .then((count) => {
            this.logger.debug(`after hangup there are ${count} active calls for this account`);
            debug(`after hangup there are ${count} active calls for this account`);
            return;
          })
          .catch((err) => this.logger.error({err}, 'Error decrementing call count'));

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
      });
    });

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uas.on('refer', this._onFeatureServerTransfer.bind(this, uas));

    uas.on('info', this._onInfo.bind(this, uas));
    uac.on('info', this._onInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uac,  ['notify', 'options', 'message']);
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

      /* if this is a re-invite from the FS to change media anchoring, avoid sending the reinvite out */
      let sdp;
      const reason = req.get('X-Reason');
      if (reason && dlg.type === 'uas' && ['release-media', 'anchor-media'].includes(reason)) {
        this.logger.info(`got a reinvite from FS to ${reason}`);
        sdp = dlg.other.remote.sdp;
      }
      else {
        sdp = await dlg.other.modify(response.sdp);
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
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  async _onInfo(dlg, req, res) {
    try {
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
        this.logger.info(`invalid Refer-To header: ${referTo.uri}`);
        return res.send(501);
      }
      res.send(202);

      // invite to new fs
      const headers = {};
      if (req.has('X-Retain-Call-Sid')) {
        Object.assign(headers, {'X-Retain-Call-Sid': req.get('X-Retain-Call-Sid')});
      }
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

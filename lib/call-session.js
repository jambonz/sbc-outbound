const Emitter = require('events');
const sdpTransform = require('sdp-transform');
const SrsClient = require('@jambonz/siprec-client-utils');
const {makeRtpEngineOpts, nudgeCallCounts, isPrivateVoipNetwork, isBlackListedSipGateway} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {SipError, stringifyUri, parseUri} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-outbound');

const makeInviteInProgressKey = (callid) => `sbc-out-iip${callid}`;
const IMMUTABLE_HEADERS = ['via', 'from', 'to', 'call-id', 'cseq', 'max-forwards', 'content-length'];

const createBLegFromHeader = ({
  logger,
  req,
  host,
  fromUser,
  register_from_domain,
  transport,
  teams = false,
  scheme = 'sip'
}) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  const transportParam = transport ? `;transport=${transport}` : '';

  logger.debug({from, fromUser, uri, host, scheme, transport, teams}, 'createBLegFromHeader');
  /* user */
  const user = fromUser || req.get('X-Preferred-From-User') || uri.user || 'anonymous';

  /* host */
  if (!host) {
    if (teams) {
      host = req.get('X-MS-Teams-Tenant-FQDN');
    }
    else if (req.has('X-Preferred-From-Host')) {
      host = req.get('X-Preferred-From-Host');
    } else if (register_from_domain) {
      host = register_from_domain;
    }
    else {
      host = 'localhost';
    }
  }

  if (from.name) {
    return `${from.name} <${scheme}:${user}@${host}${transportParam}>`;
  }
  return `<${scheme}:${user}@${host}${transportParam}>`;
};

const createBLegToHeader = (req, teams) => {
  const to = req.getParsedHeader('To');
  const host = teams ? req.get('X-MS-Teams-Tenant-FQDN') : 'localhost';
  const uri = parseUri(to.uri);
  if (uri && uri.user) return `sip:${uri.user}@${host}`;
  return `sip:anonymous@${host}`;
};

const initCdr = (req, invite) => {
  const {srf} = req;
  const {trace_id} = req.locals;
  const uri = parseUri(invite.uri);
  const regex = /^\+(\d+)$/;
  let arr = regex.exec(invite.calledNumber);
  const to = arr ? arr[1] : invite.calledNumber;
  arr = regex.exec(invite.callingNumber);
  const from = arr ? arr[1] : invite.callingNumber;
  const applicationSid = req.get('X-Application-Sid');

  return {
    account_sid: req.get('X-Account-Sid'),
    call_sid: req.get('X-Call-Sid'),
    sip_callid: invite.get('Call-ID'),
    ...(applicationSid && {application_sid: applicationSid}),
    from,
    to,
    duration: 0,
    answered: false,
    attempted_at: Date.now(),
    direction: 'outbound',
    host: srf.locals.sipAddress,
    remote_host: uri.host,
    trace_id: trace_id || '00000000000000000000000000000000'
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
    this.idleEmitter = this.srf.locals.idleEmitter;
    this.activeCallIds = this.srf.locals.activeCallIds;
    this.writeCdrs = this.srf.locals.writeCdrs;

    this.decrKey = req.srf.locals.realtimeDbHelpers.decrKey;

    const {
      lookupOutboundCarrierForAccount,
      lookupCarrierBySid,
      lookupSipGatewaysByCarrier,
      lookupCarrierByAccountLcr
    } = this.srf.locals.dbHelpers;
    this.lookupOutboundCarrierForAccount = lookupOutboundCarrierForAccount;
    this.lookupCarrierBySid = lookupCarrierBySid;
    this.lookupSipGatewaysByCarrier = lookupSipGatewaysByCarrier;
    this.lookupCarrierByAccountLcr = lookupCarrierByAccountLcr;

    this._mediaReleased = false;
    this.recordingNoAnswerTimeout = (process.env.JAMBONES_RECORDING_NO_ANSWER_TIMEOUT || 2) * 1000;
  }

  get service_provider_sid() {
    return this.req.locals.service_provider_sid;
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

  get calleeIsUsingSrtp() {
    const tp = this.rtpEngineOpts?.uac?.mediaOpts['transport-protocol'];
    return tp && -1 !== tp.indexOf('SAVP');
  }

  subscribeForDTMF(dlg) {
    if (!this._subscribedForDTMF) {
      this._subscribedForDTMF = true;
      this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag,
        this._onDTMF.bind(this, dlg));
    }
  }
  unsubscribeForDTMF() {
    if (this._subscribedForDTMF) {
      this._subscribedForDTMF = false;
      this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag);
    }
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
    const {client, createHash, retrieveHash} = this.srf.locals.realtimeDbHelpers;
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
    this.srsClients = [];

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, this.useWss || teams, false, teams);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    let proxy, uris = [];
    const mapGateways = new Map();
    let encryptedMedia = false;

    try {
      // determine where to send the call
      debug(`connecting call: ${JSON.stringify(this.req.locals)}`);
      const headers = {
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
        uris = [{
          private_network: contact.includes('transport=ws') ? false : await isPrivateVoipNetwork(destUri),
          uri: destUri
        }];
        if (!contact.includes('transport=ws')) {
          proxy = this.req.locals.registration.proxy;
        }
        this.logger.info(`sending call to registered user ${destUri}`);
      }
      else if (this.req.locals.target === 'forward') {
        uris = [{
          private_network: await isPrivateVoipNetwork(this.req.uri),
          uri: this.req.uri
        }];
        if (this.req.has('X-SIP-Proxy')) {
          proxy = this.req.get('X-SIP-Proxy');
          if (!proxy.startsWith('sip:') && !proxy.startsWith('sips:')) proxy = `sip:${proxy}`;
        }
      }
      else if (teams) {
        const vmailParam = 'opaque=app:voicemail';
        proxy = `sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com:5061;transport=tls`;
        if (this.req.uri.includes(vmailParam)) {
          uris = [{
            private_network: false,
            uri: `sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com;${vmailParam}`
          }];
        }
        else uris = [{
          private_network: false,
          uri: `sip:${this.req.calledNumber}@sip.pstnhub.microsoft.com`
        }];
      }
      else {
        try {
          /* was a specific carrier requested */
          let voip_carrier_sid = this.req.get('X-Requested-Carrier-Sid');
          const account_sid = this.req.get('X-Account-Sid');
          if (!voip_carrier_sid && account_sid) {
            /* search for an LCR table for this account or service provider */
            voip_carrier_sid = await this.lookupCarrierByAccountLcr(account_sid, this.req.calledNumber);
          }
          if (!voip_carrier_sid) {
            /* no LCR for this account/SP - try with inbound carrier */
            const inbound_carrier_sid = this.req.get('X-Voip-Carrier-Sid');
            if (inbound_carrier_sid) {
              const gateways = await this.lookupSipGatewaysByCarrier(inbound_carrier_sid);
              const gws = (gateways || [])
                .filter((gw) => gw.outbound);
              if (gws.length) {
                voip_carrier_sid = inbound_carrier_sid;
              }
            }
          }
          if (!voip_carrier_sid) {
            /* no LCR/ inbound carrier for this account/SP - at this point its a random shuffle of outbound carriers */
            voip_carrier_sid = await this.lookupOutboundCarrierForAccount(this.account_sid);
          }
          if (!voip_carrier_sid) {
            /* no outbound carriers exist for this account/SP */
            this.logger.info(`no outbound carriers found for account_sid ${account_sid}`);
            this.res.send(603);
            return this.srf.endSession(this.req);
          }
          const vc = await this.lookupCarrierBySid(voip_carrier_sid);
          const gateways = await this.lookupSipGatewaysByCarrier(voip_carrier_sid);
          const goodGateways = [];
          for (const g of gateways) {
            if (!await isBlackListedSipGateway(client, this.logger, g.sip_gateway_sid)) {
              goodGateways.push(g);
            }
          }
          const gws = (goodGateways || [])
            .filter((gw) => gw.outbound);
          if (gws.length) {
            uris = [];
            gws.forEach((o) => {
              const calledNumber = this.req.calledNumber.startsWith('+') ?
                this.req.calledNumber.slice(1) :
                this.req.calledNumber;
              const prefix = vc.tech_prefix || '';
              const transport =  o.protocol?.startsWith('tls') ? 'tls' : (o.protocol || 'udp');
              const hostport = !o.port || 5060 === o.port ? o.ipv4 : `${o.ipv4}:${o.port}`;
              const prependPlus = vc.e164_leading_plus && !this.req.calledNumber.startsWith('0') ? '+' : '';
              const scheme = transport === 'tls' && !process.env.JAMBONES_USE_BEST_EFFORT_TLS && o.use_sips_scheme ?
                'sips' : 'sip';
              let u = `${scheme}:${prefix}${prependPlus}${calledNumber}@${hostport};transport=${transport}`;
              const obj = {
                name: vc.name,
                diversion: vc.diversion,
                hostport,
                transport,
                scheme,
                register_from_domain: vc.register_from_domain
              };
              if (vc.register_username && vc.register_password) {
                obj.auth = {
                  username: vc.register_username,
                  password: vc.register_password
                };
              }
              if (vc.requires_register && vc.register_sip_realm?.length > 0) {
                proxy = u;
                u = `${scheme}:${prefix}${prependPlus}${calledNumber}@${vc.register_sip_realm};transport=${transport}`;
                this.logger.debug({uri: u}, `using outbound proxy for this registered trunk: ${proxy}`);
              }
              mapGateways.set(u, obj);
              uris.push(u);
              this.logger.debug({gateway: o}, `pushed uri ${u}`);
              if (o.protocol === 'tls/srtp') {
                /**  TODO: this is a bit of a hack in the sense that we are not
                 * supporting a scenario where you have a carrier with several outbound
                 * gateways, some requiring encrypted media and some not.  This should be rectified
                 * but it will require more significant changes and right now it seems
                 * like a rare use case -- encryption is usually an all or nothing requirement.
                 */
                this.logger.info({u}, `using SRTP for outbound call, pad crypto: ${o.pad_crypto ? 'yes' : 'no'}`);
                this.rtpEngineOpts = makeRtpEngineOpts(this.req, false, true, o.pad_crypto, true);
                encryptedMedia = true;
              }
            });
            /* Check private network for each gw */
            uris = await Promise.all(uris.map(async(u) => {
              return {
                private_network: await isPrivateVoipNetwork(u),
                uri: u
              };
            }));
            this.logger.debug({uris, voip_carrier_sid}, 'selected outbound gateways for requested carrier');
          }
          else {
            this.logger.info({voip_carrier_sid}, 'no outbound gateways found for requested carrier');
            this.res.send(603);
          }
        } catch (err) {
          debug(err);
          this.logger.error(err, 'Error performing lcr');
          this.res.send(488);
          return this.srf.endSession(this.req);
        }
        debug(`sending call to PSTN ${uris}`);
      }

      /* private_network should be called at last - try public first */
      uris = uris.sort((a, b) => a.private_network - b.private_network);
      const toPrivate = uris.some((u) => u.private_network === true);
      const toPublic = uris.some((u) => u.private_network === false);
      let isOfferUpdatedToPrivate = toPrivate && !toPublic;

      const opts = updateRtpEngineFlags(this.req.body, {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  ['private', toPublic ? 'public' : 'private'],
        sdp: this.req.body
      });
      let response = await this.offer(opts);
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
        let hdrs = { ...headers };
        const {private_network, uri} = uris.shift();

        /* if we've exhausted attempts to public endpoints and are switching to trying private, we need new rtp */
        if (private_network && !isOfferUpdatedToPrivate) {
          this.logger.info('switching to attempt to deliver call via private network now..');
          this.rtpEngineResource.destroy()
            .catch((err) => this.logger.info({err}, 'Error destroying rtpe to re-connect to private network'));
          response = await this.offer({
            ...opts,
            direction: ['private', 'private']
          });
          isOfferUpdatedToPrivate = true;
        }

        /* on the second and subsequent attempts, use the same Call-ID and CSeq from the first attempt */
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

        /* INVITE request line and To header should be the same. */
        hdrs = {...hdrs, 'To': uri};

        /* only now can we set Contact & From header since they depend on transport and scheme of gw */
        const gw = mapGateways.get(uri);
        if (gw) {
          const {scheme, transport} = gw;
          this.logger.info({gw}, `sending INVITE to ${uri} via carrier ${gw.name}`);
          hdrs = {
            ...hdrs,
            From: gw.register_from_domain ?
              createBLegFromHeader({
                logger: this.logger,
                req: this.req,
                register_from_domain: gw.register_from_domain,
                scheme,
                transport,
                ...(private_network && {host: this.privateSipAddress})
              }) :
              createBLegFromHeader({
                logger: this.logger,
                req: this.req,
                scheme,
                transport,
                ...(private_network && {host: this.privateSipAddress})
              }),
            Contact: createBLegFromHeader({
              logger: this.logger,
              req: this.req,
              ...(gw.auth?.username && {fromUser: gw.auth?.username}),
              scheme,
              transport,
              ...(private_network && {host: this.privateSipAddress})
            }),
            ...(gw.diversion && {
              Diversion: gw.diversion.startsWith('+') ?
                `<sip:${gw.diversion}@${gw.hostport}>;reason=unknown;counter=1;privacy=off` :
                `<sip:+${gw.diversion}@${gw.hostport}>;reason=unknown;counter=1;privacy=off`
            })
          };
        }
        else if (teams) {
          hdrs = {
            ...hdrs,
            'From': createBLegFromHeader({logger: this.logger, req: this.req, teams: true, transport: 'tls'}),
            'Contact': `sip:${this.req.calledNumber}@${this.req.get('X-MS-Teams-Tenant-FQDN')}:5061;transport=tls`
          };
        }
        else {
          hdrs = {
            ...hdrs,
            'From': createBLegFromHeader({
              logger: this.logger,
              req: this.req,
              ...(private_network && {host: this.privateSipAddress})
            }),
            'Contact': createBLegFromHeader({
              logger: this.logger,
              req: this.req,
              ...(private_network && {host: this.privateSipAddress})
            })
          };
          const p = proxy ? ` via ${proxy}` : '';
          this.logger.info({uri, p}, `sending INVITE to ${uri}${p}`);
        }

        /* now launch an outbound call attempt */
        const passFailure = 0 === uris.length;  // only propagate failure on last attempt
        try {
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
              '-X-Preferred-From-Host',
              '-X-Jambonz-FS-UUID',
              '-X-Voip-Carrier-Sid',
              '-X-SIP-Proxy'
            ],
            proxyResponseHeaders: [
              'all',
              '-Allow',
              '-Session-Expires'
            ],
            // Add X-CID header to feature server response.
            // to allow calling/status hooks contains sbc_callid.
            responseHeaders: (uacRes, headers) => {
              headers['X-CID'] = uacRes.get('Call-ID');
            },
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
                flags: ['single codec', 'inject DTMF'],
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
              if (this.req.locals.account?.disable_cdrs) {
                this.logger.debug('cdrs disabled for this account');
              }
              else {
                this.req.locals.cdr = {
                  ...initCdr(this.req, inv),
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

              this.contactHeader = inv.get('Contact');
              this.logger.info(`outbound call attempt to ${uri} has contact header ${this.contactHeader}`);
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
            encryptedMedia ||               // cant crank back when using encrypted media as keys have been exchanged
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
            return;
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
      dlg.on('destroy', async(bye) => {
        const other = dlg.other;
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        this.unsubscribeForDTMF();
        //this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag);
        try {
          const headers = {};
          Object.keys(bye.headers).forEach((h) => {
            if (!IMMUTABLE_HEADERS.includes(h)) headers[h] = bye.headers[h];
          });
          await other.destroy({headers});
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
          const day = new Date();
          const recordAllCalls = this.req.locals.record_all_calls;
          let recording_url = `/Accounts/${this.account_sid}/RecentCalls/${this.req.locals.cdr.call_sid}/record`;
          recording_url += `/${day.getFullYear()}/${(day.getMonth() + 1).toString().padStart(2, '0')}`;
          recording_url += `/${day.getDate().toString().padStart(2, '0')}/${recordAllCalls}`;
          this.writeCdrs({...this.req.locals.cdr,
            terminated_at: now,
            termination_reason: dlg.type === 'uas' ? 'caller hungup' : 'called party hungup',
            sip_status: 200,
            answered: true,
            duration: Math.floor((now - callStart) / 1000),
            ...(recordAllCalls && {recording_url})
          }).catch((err) => this.logger.error({err}, 'Error writing cdr for completed call'));
        }
        /* de-link the 2 Dialogs for GC */
        dlg.removeAllListeners();
        other.removeAllListeners();
        dlg.other = null;
        other.other = null;

        this._stopRecording();

        this.logger.info(`call ended with normal termination, there are ${this.activeCallIds.size} active`);
        if (this.activeCallIds.size === 0) this.idleEmitter.emit('idle');
        this.srf.endSession(this.req);
      });
    });

    this.subscribeForDTMF(uas);
    //this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uac.tag,
    //  this._onDTMF.bind(this, uas));

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uas.on('refer', this._onFeatureServerTransfer.bind(this, uas));
    uac.on('refer', this._onRefer.bind(this, uac));

    uas.on('info', this._onInfo.bind(this, uas));
    uac.on('info', this._onInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uac,  ['notify', 'options', 'message']);
  }

  _startRecordingNoAnswerTimer(res) {
    this._clearRecordingNoAnswerTimer();
    this.recordingNoAnswerTimer = setTimeout(() => {
      this.logger.info('No response from SipRec server, return error to feature server');
      this.isRecordingNoAnswerResponded = true;
      res.send(400);
    }, this.recordingNoAnswerTimeout);
  }

  _clearRecordingNoAnswerTimer() {
    if (this.recordingNoAnswerTimer) {
      clearTimeout(this.recordingNoAnswerTimer);
      this.recordingNoAnswerTimer = null;
    }
  }

  _stopRecording() {
    if (this.srsClients.length) {
      this.srsClients.forEach((c) => c.stop());
      this.srsClients = [];
    }
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
      // DH: this was restarting ICE, which we don't want to do
      //if (reason && opts.flags && !opts.flags.includes('reset')) opts.flags.push('reset');

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      this.logger.debug({opts, response}, 'CallSession:_onReinvite: (offer)');

      /* if this is a re-invite from the FS to change media anchoring, avoid sending the reinvite out */
      let sdp;
      if (isReleasingMedia && !this.calleeIsUsingSrtp) {
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
      /* now remove asymmetric as B party (looking at you Genesys ring group) may need port re-learning on invites  */
      answerMedia.flags = answerMedia.flags.filter((f) => f !== 'asymmetric');
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      this.logger.debug({opts, sdp: response.sdp}, 'CallSession:_onReinvite: (answer) sending back upstream');
      res.send(200, {
        body: response.sdp,
        headers: {
          'Contact': this.contactHeader
        }
      });
    } catch (err) {
      res.send(err.status || 500);
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
          const headers = contentType === 'application/json' && req.body ? JSON.parse(req.body) : {};
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
            if (this.srsClients.length) {
              res.send(400);
              this.logger.info('discarding duplicate startCallRecording request for a call');
              return;
            }
            if (!srsUrl) {
              this.logger.info('startCallRecording request is missing X-Srs-Url header');
              res.send(400);
              return;
            }
            const arr = srsUrl.split(',');
            this.srsClients = arr.map((url) => new SrsClient(this.logger, {
              srf: dlg.srf,
              direction: 'outbound',
              originalInvite: this.req,
              callingNumber: this.req.callingNumber,
              calledNumber: this.req.calledNumber,
              srsUrl: url,
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
              unsubscribe: this.unsubscribe,
              headers
            }));
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => c.start()));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error starting SipRec call recording');
              succeeded = false;
            }
          }
          else if (reason === 'stopCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated)) {
              res.send(400);
              this.logger.info('discarding stopCallRecording request because we are not recording');
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated) {
                  c.stop();
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error stopping SipRec call recording');
              succeeded = false;
            }
            this.srsClients = [];
          }
          else if (reason === 'pauseCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated && !c.paused)) {
              this.logger.info('discarding invalid pauseCallRecording request');
              res.send(400);
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated && !c.paused) {
                  c.pause({headers});
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error pausing SipRec call recording');
              succeeded = false;
            }
          }
          else if (reason === 'resumeCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated && c.paused)) {
              res.send(400);
              this.logger.info('discarding invalid resumeCallRecording request');
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated && c.paused) {
                  c.resume({headers});
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error resuming SipRec call recording');
              succeeded = false;
            }
          }
          if (!this.isRecordingNoAnswerResponded) {
            this._clearRecordingNoAnswerTimer();
            res.send(succeeded ? 200 : 503);
          }
        } else if (reason.includes('Dtmf')) {
          const arr = /Signal=\s*([0-9#*])/.exec(req.body);
          if (!arr) {
            this.logger.info({body: req.body}, '_onInfo: invalid INFO Dtmf');
            throw new Error(`_onInfo: no dtmf in body for ${contentType}`);
          }
          const code = arr[1];
          const arr2 = /Duration=\s*(\d+)/.exec(req.body);
          const duration = arr2 ? arr2[1] : 250;
          const dtmfOpts = {
            ...this.rtpEngineOpts.common,
            'from-tag': this.rtpEngineOpts.uas.tag,
            code,
            duration
          };
          const response = await this.playDTMF(dtmfOpts);
          if ('ok' !== response.result) {
            this.logger.info({response}, `rtpengine play Dtmf failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
        }
      }
      else if (dlg.type === 'uac' && ['application/dtmf-relay', 'application/dtmf'].includes(contentType)) {
        const arr = /Signal=\s*([0-9#*])/.exec(req.body);
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
        const headers = {};
        Object.keys(req.headers).forEach((h) => {
          if (!IMMUTABLE_HEADERS.includes(h)) headers[h] = req.headers[h];
        });
        const response = await dlg.other.request({method: 'INFO', headers, body: req.body});
        const responseHeaders = {};
        if (response.has('Content-Type')) {
          Object.assign(responseHeaders, {'Content-Type': response.get('Content-Type')});
        }
        res.send(response.status, {headers: responseHeaders, body: response.body});
      }
    } catch (err) {
      this.logger.info({err}, `Error handing INFO request on ${dlg.type} leg`);
    }
  }

  async _onFeatureServerTransfer(dlg, req, res) {
    try {
      // the following properties are ignored in the REFER headers
      // eslint-disable-next-line no-unused-vars
      const { via, from, to, 'call-id': callid, cseq, 'max-forwards': maxforwards,
      // eslint-disable-next-line no-unused-vars
        'content-length': _contentlength, 'refer-to': _referto, 'referred-by': _referredby,
        // eslint-disable-next-line no-unused-vars
        'X-Refer-To-Leave-Untouched': _leave,
        ...customHeaders
      } = req.headers;

      const referTo = req.getParsedHeader('Refer-To');
      const uri = parseUri(referTo.uri);
      this.logger.info({uri, referTo}, 'received REFER from feature server');
      const arr = /context-(.*)/.exec(uri.user);
      if (!arr) {
        /* call transfer requested */
        const referredBy = req.getParsedHeader('Referred-By');
        if (!referredBy) return res.send(400);
        const u = parseUri(referredBy.uri);

        /* delete contact if it was there from feature server */
        delete customHeaders['contact'];

        const response = await this.uac.request({
          method: 'REFER',
          headers: {
            'Refer-To': `<${stringifyUri(uri)}>`,
            'Referred-By': `<${stringifyUri(u)}>`,
            ...customHeaders
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

      const uac = await this.srf.createUAC(referTo.uri, {localSdp: dlg.local.sdp, headers});
      this.uas = uac;
      uac.type = 'uas';
      uac.other = this.uac;
      this.uac.other = uac;
      uac.on('info', this._onInfo.bind(this, uac));
      uac.on('modify', this._onReinvite.bind(this, uac));
      uac.on('refer', this._onFeatureServerTransfer.bind(this, uac));
      uac.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        if (this.activeCallIds.size === 0) this.idleEmitter.emit('idle');
        uac.other.destroy();
        this.srf.endSession(this.req);
      });

      const opts = {
        ...this.rtpEngineOpts.common,
        'from-tag': this.rtpEngineOpts.uas.tag,
        sdp: uac.remote.sdp,
        flags: ['port latching']
      };
      const response = await this.offer(opts);
      if ('ok' !== response.result) {
        throw new Error(`_onFeatureServerTransfer: rtpengine offer failed: ${JSON.stringify(response)}`);
      }
      dlg.destroy().catch(() => {});
      this.logger.info('successfully moved call to new feature server');
    } catch (err) {
      res.send(488);
      this.logger.error(err, 'Error handling refer from feature server');
    }
  }
}

module.exports = CallSession;

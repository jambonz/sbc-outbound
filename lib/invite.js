const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const {makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const debug = require('debug')('jambonz:sbc-outbound');

module.exports = handler;

async function handler(req, res) {
  const logger = req.locals.logger;
  const srf = req.srf;
  const useWss = req.locals.registration && req.locals.registration.protocol === 'wss';
  const rtpEngineOpts = makeRtpEngineOpts(req, false, useWss);
  const rtpEngineResource = {destroy: del.bind(rtpengine, rtpEngineOpts.common)};
  try {
    const response = await offer(rtpEngineOpts.offer);
    if ('ok' !== response.result) {
      res.send(480);
      throw new Error(`failed allocating rtpengine endpoint: ${JSON.stringify(response)}`);
    }

    let uri, proxy;
    if (req.locals.registration) {
      proxy = req.locals.registration.contact;
      uri = req.uri;
    }
    else {
      uri = config.get('trunks.outbound.host');
    }

    const {uas, uac} = await srf.createB2BUA(req, res, uri, {
      proxy,
      proxyRequestHeaders: ['User-Agent', 'Subject'],
      localSdpB: response.sdp,
      localSdpA: (sdp, res) => {
        const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
          rtpEngineOpts.answer);
        return answer(opts)
          .then((response) => {
            if ('ok' !== response.result) throw new Error('error allocating rtpengine');
            return response.sdp;
          });
      }
    });
    logger.info('call connected');
    debug('call connected');
    setHandlers(logger, uas, uac, rtpEngineOpts, rtpEngineResource);

  } catch (err) {
    logger.error(err, 'Error connecting call');
    rtpEngineResource.destroy();
  }
}

function setHandlers(logger, uas, uac, rtpEngineOpts, rtpEngineResource) {
  [uas, uac].forEach((dlg) => {
    //hangup
    dlg.on('destroy', () => {
      logger.info('call ended');
      rtpEngineResource.destroy();
    });

    //re-invite
    dlg.on('modify', onReinvite.bind(dlg, logger, rtpEngineOpts));
  });

  // default forwarding of other request types
  forwardInDialogRequests(uas);
}

async function onReinvite(logger, rtpEngineOpts, req, res) {
  try {
    let response = await offer(Object.assign({sdp: req.body}, rtpEngineOpts.offer));
    if ('ok' !== response.result) {
      res.send(488);
      throw new Error(`failed allocating rtpengine endpoint: ${JSON.stringify(response)}`);
    }
    const sdp = await this.other.modify(response.sdp);
    const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
      rtpEngineOpts.answer);
    response = await answer(opts);
    if ('ok' !== response.result) {
      res.send(488);
      throw new Error(`failed allocating rtpengine endpoint: ${JSON.stringify(response)}`);
    }
    res.send(200, {body: response.sdp});
  } catch (err) {
    logger.error(err, 'Error handling reinvite');
  }
}

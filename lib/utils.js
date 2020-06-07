const rtpCharacteristics = require('../data/rtp-transcoding');
const srtpCharacteristics = require('../data/srtp-transcoding');
const debug = require('debug')('jambonz:sbc-outbound');

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp, teams = false) {
  const from = req.getParsedHeader('from');
  const srtpOpts = teams ? srtpCharacteristics['teams'] : srtpCharacteristics['default'];
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  return {
    common,
    offer: Object.assign(
      {'sdp': req.body, 'replace': ['origin', 'session-connection']},
      {'direction': [ 'private', 'public']},
      common,
      dstIsUsingSrtp ? srtpOpts : rtpCharacteristics),
    answer: Object.assign(
      {'replace': ['origin', 'session-connection']},
      common,
      srcIsUsingSrtp ? srtpOpts : rtpCharacteristics)
  };
}

function selectHostPort(hostport, protocol) {
  debug(`selectHostPort: ${hostport}, ${protocol}`);
  const sel = hostport
    .split(',')
    .map((hp) => {
      const arr = /(.*)\/(.*):(.*)/.exec(hp);
      return [arr[1], arr[2], arr[3]];
    })
    .filter((hp) => {
      return hp[0] === protocol && hp[1] !== '127.0.0.1';
    });
  return sel[0];
}

function pingMs(logger, srf, gateway, fqdns) {
  const uri = `sip:${gateway}`;
  const proxy = `sip:${gateway}:5061;transport=tls`;
  fqdns.forEach((fqdn) => {
    const contact = `<sip:${fqdn}:5061;transport=tls>`;
    srf.request(uri, {
      method: 'OPTIONS',
      proxy,
      headers: {
        'Contact': contact,
        'From': contact,
      }
    }).catch((err) => logger.error(err, `Error pinging MS Teams at ${gateway}`));
  });
}
function pingMsTeamsGateways(logger, srf) {
  const {lookupAllTeamsFQDNs} = srf.locals.dbHelpers;
  lookupAllTeamsFQDNs()
    .then((fqdns) => {
      if (fqdns.length > 0) {
        ['sip.pstnhub.microsoft.com', 'sip2.pstnhub.microsoft.com', 'sip3.pstnhub.microsoft.com']
          .forEach((gw) => {
            setInterval(pingMs.bind(this, logger, srf, gw, fqdns), 60000);
          });
      }
      return;
    })
    .catch((err) => {
      logger.error(err, 'Error looking up all ms teams fqdns');
    });
}

module.exports = {
  makeRtpEngineOpts,
  selectHostPort,
  pingMsTeamsGateways
};

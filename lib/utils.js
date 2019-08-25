const config = require('config');
let idx = 0;
const debug = require('debug')('jambonz:sbc-outbound');

function fromInboundTrunk(req) {
  const trunks = config.has('trunks.inbound') ?
    config.get('trunks.inbound') : [];
  if (isWSS(req)) return false;
  const trunk = trunks.find((t) => t.host.includes(req.source_address));
  if (!trunk) return false;
  req.carrier_name = trunk.name;
  return true;
}

function isWSS(req) {
  return req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws');
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

function getAppserver() {
  const len = config.get('trunks.appserver').length;
  return config.get('trunks.appserver')[ idx++ % len];
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
  const srtpCharacteristics = config.get('transcoding.srtpCharacteristics');
  return {
    common,
    offer: Object.assign({'sdp': req.body, 'replace': ['origin', 'session-connection']}, common,
      dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics),
    answer: Object.assign({}, common, srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics)
  };
}

module.exports = {
  fromInboundTrunk,
  isWSS,
  getAppserver,
  makeRtpEngineOpts,
  selectHostPort
};

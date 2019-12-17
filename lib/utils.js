const config = require('config');
const debug = require('debug')('jambonz:sbc-outbound');

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

module.exports = {
  makeRtpEngineOpts,
  selectHostPort
};

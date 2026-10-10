const test = require('tape');
const {getRegisteringSbc} = require('../lib/utils');

const now = Date.parse('2026-10-10T12:00:00.000Z');
const carrier = (status) => ({requires_register: 1, register_status: JSON.stringify(status)});
const ok = {
  status: 'ok',
  sbcAddress: '203.0.113.1:5060',
  privateSbcAddress: '10.0.0.1:5060',
  timestamp: '2026-10-10T11:59:00.000Z',
  expires: 3600
};

test('getRegisteringSbc', (t) => {
  t.equal(getRegisteringSbc(carrier(ok), now), '10.0.0.1:5060', 'returns the SBC holding a current registration');
  t.equal(getRegisteringSbc({...carrier(ok), requires_register: 0}, now), undefined,
    'ignores carriers that do not register');
  t.equal(getRegisteringSbc(carrier({...ok, status: 'fail'}), now), undefined, 'ignores a failed registration');
  t.equal(getRegisteringSbc(carrier({...ok, expires: 30}), now), undefined, 'ignores an expired registration');
  t.equal(getRegisteringSbc(carrier({...ok, privateSbcAddress: undefined}), now), undefined,
    'ignores status written by an older sidecar');
  t.equal(getRegisteringSbc({requires_register: 1, register_status: null}, now), undefined, 'handles no status');
  t.equal(getRegisteringSbc({requires_register: 1, register_status: '{bad'}, now), undefined,
    'handles malformed status');
  t.end();
});

const test = require('blue-tape');
const { output, sippUac } = require('./sipp')('test_sbc-outbound');
const debug = require('debug')('jambonz:sbc-outbound');
const clearModule = require('clear-module');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('sbc-outbound tests', async(t) => {
  const {srf} = require('../app');

  try {
    await connect(srf);
    await sippUac('uac-register-auth-success.xml', {ip: '172.39.0.31', data_file: 'good_user.csv'});
    t.pass('sip user/device registered over udp');
    const p = sippUac('uas.xml', {ip: '172.39.0.31'});
    await sippUac('uac-pcap-device-success.xml');
    await p;
    t.pass('successfully completed outbound call to the registered user/devices');
    await sippUac('uac-pcap-device-404.xml');
    t.pass('return 404 to outbound attempt to unregisteted user/device');
    await sippUac('uac-pcap-carrier-success.xml');
    t.pass('successfully completed outbound call to configured sip trunk');

    srf.disconnect();
  } catch (err) {
    console.error(err);
    srf.disconnect();
    t.error(err);
  }
});

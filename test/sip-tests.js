const test = require('tape');
const { output, sippUac } = require('./sipp')('test_sbc-outbound');
const {execSync} = require('child_process');
const debug = require('debug')('jambonz:sbc-outbound');
const bent = require('bent');
const getJSON = bent('json');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms * 1000);
  });
}

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('sbc-outbound tests', async(t) => {
  const {srf} = require('../app');
  const { queryCdrs } = srf.locals;
  const redisClient = srf.locals.realtimeDbHelpers.client;

  try {
    await connect(srf);
  
    let obj = await getJSON('http://127.0.0.1:3050/');
    t.ok(obj.calls === 0, 'HTTP GET / works (current call count)')
    obj = await getJSON('http://127.0.0.1:3050/system-health');
    t.ok(obj.calls === 0, 'HTTP GET /system-health works (health check)')

    /* call to unregistered user */
    debug('successfully connected to drachtio server');
    await sippUac('uac-pcap-device-404.xml');
    t.pass('return 404 to outbound attempt to unregistered user/device');

    /* call to PSTN with no lcr configured */
    await sippUac('uac-pcap-carrier-success.xml');
    t.pass('successfully completed outbound call to sip trunk');

    /* call to Sip URI with no lcr configured */
    await sippUac('uac-pcap-sip-routing-success.xml');
    t.pass('successfully completed outbound call to sip routing trunk');

    /* call to PSTN with no lcr configured */
    await sippUac('uac-pcap-inbound-carrier-success.xml');
    t.pass('successfully completed outbound call to sip trunk');

    /* call to PSTN with request uri we see in kubernetes */
    await sippUac('uac-pcap-carrier-success-k8s.xml');
    t.pass('successfully completed outbound call to sip trunk (k8S req uri)');

    // re-rack test data
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data2.sql`);

    /* call to PSTN with lcr configured */
    await sippUac('uac-pcap-carrier-success.xml');
    t.pass('successfully completed outbound call using LCR');

    // re-rack test data
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data3.sql`);

    /* call to PSTN where caller hangs up during outdial */
    await sippUac('uac-cancel.xml');
    t.pass('successfully handled caller hangup during lcr outdial');

    // re-rack test data
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data4.sql`);

    /* reinvite after call established */
    await sippUac('uac-pcap-carrier-success-reinvite.xml');
    t.pass('successfully handled reinvite during lcr outdial');

    /* invite to sipUri that challenges */
    await sippUac('uac-sip-uri-auth-success.xml');
    t.pass('successfully connected to sip uri that requires auth');
  
    /* invite to sipUri through proxy */
    await sippUac('uac-sip-uri-proxy.xml');
    t.pass('successfully connected to sip uri through proxy');
  
    // re-rack test data
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data5.sql`);
    
    /* fails when session limit exceeded */
    await sippUac('uac-pcap-carrier-fail-limits.xml');
    t.pass('fails when max calls in progress');

    // re-rack test data
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`);
    execSync(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data.sql`);

    // Black list good carrier for some seconds
    await redisClient.setex('blacklist-sip-gateway:124a5339-c62c-4075-9e19-f4de70a96597', 3, '');
    await sippUac('uac-pcap-carrier-fail-blacklist.xml');
    t.pass('fails when carrier is blacklisted');
    await redisClient.del('blacklist-sip-gateway:124a5339-c62c-4075-9e19-f4de70a96597');

    await waitFor(25);

    const res = await queryCdrs({account_sid: 'ed649e33-e771-403a-8c99-1780eabbc803'});
    console.log(`${res.total} cdrs: ${JSON.stringify(res)}`);
    t.ok(res.total === 9, 'wrote 9 cdrs');

    srf.disconnect();
  } catch (err) {
    console.error(err);
    srf.disconnect();
    t.error(err);
  }
});

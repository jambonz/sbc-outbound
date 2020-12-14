const test = require('blue-tape');
//const test = require('tape').test ;
const exec = require('child_process').exec ;

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {

    // wait 5 secs for mysql to be ready for connections
    setTimeout(() => {
      t.pass('docker started');
      t.end(err);  
    }, 15000);
  });
});

  

const test = require('tape');
const exec = require('child_process').exec ;
const pwd = '-p$MYSQL_ROOT_PASSWORD';

test('creating jambones_test database', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp < ${__dirname}/db/create_test_db.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('database successfully created');
    t.end();
  });
});

test('creating schema', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp -D jambones_test < ${__dirname}/db/jambones-sql.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('schema successfully created');
    t.end();
  });
});

test('populating test case data', (t) => {
  exec(`mysql -h 127.0.0.1 -u root  --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('test data set created');
    t.end();
  });
});

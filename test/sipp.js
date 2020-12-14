const { spawn } = require('child_process');
const debug = require('debug')('jambonz:ci');
let network;
const obj = {};
let output = '';
let idx = 1;

function clearOutput() {
  output = '';
}

function addOutput(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) output += str.charAt(i);
  }
}

module.exports = (networkName) => {
  network = networkName ;
  return obj;
};

obj.output = () => {
  return output;
};

obj.sippUac = (file, opts) => {
  opts = opts || {};
  const cmd = 'docker';
  let args = [
    'run', '-ti', '--rm', '--net', `${network}`
  ]
  .concat(opts.ip ? ['--ip', opts.ip] : [])
  .concat([
    '-v', `${__dirname}/scenarios:/tmp/scenarios`,
    'drachtio/sipp', 'sipp'
  ])
  .concat(opts.remote_host ? opts.remote_host : [])
  .concat(opts.data_file ? ['-inf', `/tmp/scenarios/${opts.data_file}`] : [])
  .concat([
    '-sf', `/tmp/scenarios/${file}`,
    '-m', '1',
    '-sleep', '100ms',
    '-nostdin',
    '-cid_str', `%u-%p@%s-${idx++}`,
    'sbc'
  ]);

  debug(`args: ${args}`);
  clearOutput();

  return new Promise((resolve, reject) => {
    const child_process = spawn(cmd, args, {stdio: ['inherit', 'pipe', 'pipe']});

    child_process.on('exit', (code, signal) => {
      if (code === 0) {
        return resolve();
      }
      console.log(`sipp exited with non-zero code ${code} signal ${signal}`);
      reject(code);
    });
    child_process.on('error', (error) => {
      console.log(`error spawing child process for docker: ${args}`);
    });

    child_process.stdout.on('data', (data) => {
      debug(`stdout: ${data}`);
      addOutput(data.toString());
    });
    child_process.stdout.on('data', (data) => {
      debug(`stdout: ${data}`);
      addOutput(data.toString());
    });
  });
};

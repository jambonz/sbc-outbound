# sbc-outbound ![Build Status](https://github.com/jambonz/sbc-outbound/workflows/CI/badge.svg)

This application provides a part of the SBC (Session Border Controller) functionality of jambonz platfrom.  It handles outbound INVITE requests from the cpaas application server that is going to carrier sip trunks or registered sip users/devices, including webrtc applications. 

## Configuration

Configuration is provided via environment variables:

| variable | meaning | required?|
|----------|----------|---------|
|DRACHTIO_HOST| ip address of drachtio server (typically '127.0.0.1')|yes|
|DRACHTIO_PORT| listening port of drachtio server for control connections (typically 9022)|yes|
|DRACHTIO_SECRET| shared secret|yes|
|HTTP_PORT| tcp port listen port |no|
|JAMBONES_LOGLEVEL| log level for application, 'info' or 'debug'|no|
|JAMBONES_MYSQL_HOST| mysql host|yes|
|JAMBONES_MYSQL_USER| mysql username|yes|
|JAMBONES_MYSQL_PASSWORD|  mysql password|yes|
|JAMBONES_MYSQL_DATABASE| mysql data|yes|
|JAMBONES_MYSQL_CONNECTION_LIMIT| mysql connection limit |no|
|DTMF_LISTEN_PORT| DTMF listening port |no|
|JAMBONES_NG_PROTOCOL| rtpengine NG protocol |no|
|RTPENGINE_PORT| rtpengine port |no|
|JAMBONES_CLUSTER_ID| cluster id |no|
|JAMBONES_NETWORK_CIDR| CIDR of private network that feature server is running in (e.g. '172.31.0.0/16')|yes|
|JAMBONES_REDIS_HOST| redis host|yes|
|JAMBONES_REDIS_PORT|redis port|no|
|JAMBONES_RTPENGINES| commans-separated list of ip:ng-port for rtpengines (e.g. '172.31.32.10:22222')|yes|
|JAMBONES_TIME_SERIES_HOST| influxdb host |yes|
|JAMBONES_RECORD_ALL_CALLS| enable auto record calls |no|
|K8S| service running as kubernetes service |no|
|K8S_RTPENGINE_SERVICE_NAME| rtpengine service name(required for K8S) |no|

### running under pm2
Typically, this application runs under [pm2](https://pm2.io) using an [ecosystem.config.js](https://pm2.keymetrics.io/docs/usage/application-declaration/) file similar to this:
```js
module.exports = {
  apps : [
  {
    name: 'sbc-outbound',
    cwd: '/home/admin/apps/sbc-outbound',
    script: 'app.js',
    instance_var: 'INSTANCE_ID',
    out_file: '/home/admin/.pm2/logs/jambonz-sbc-outbound.log',
    err_file: '/home/admin/.pm2/logs/jambonz-sbc-outbound.log',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',    env: {
     NODE_ENV: 'production',
      JAMBONES_LOGLEVEL: 'info',
      DRACHTIO_HOST: '127.0.0.1',
      DRACHTIO_PORT: 9022,
      DRACHTIO_SECRET: 'cymru',
      JAMBONES_RTPENGINES: '172.31.32.10:22222',
      JAMBONES_MYSQL_HOST: 'aurora-cluster-jambonz.cluster-xxxxxxxxxxxxx.us-west-1.rds.amazonaws.com',
      JAMBONES_MYSQL_USER: 'admin',
      JAMBONES_MYSQL_PASSWORD: 'JambonzR0ck$',
      JAMBONES_MYSQL_DATABASE: 'jambones',
      JAMBONES_MYSQL_CONNECTION_LIMIT: 10,
      JAMBONES_REDIS_HOST: 'jambonz.zzzzzzz.0001.usw1.cache.amazonaws.com',
      JAMBONES_REDIS_PORT: 6379,
      JAMBONES_TIME_SERIES_HOST: '172.31.32.11',
      JAMBONES_NETWORK_CIDR: '172.31.0.0/16'
    }
  }]
};
```

#### Running the test suite
To run the included test suite, you will need to have docker installed on your laptop.
```
npm test
```

# sbc-outbound [![Build Status](https://secure.travis-ci.org/jambonz/sbc-outbound.png)](http://travis-ci.org/jambonz/sbc-outbound)

This application provides a part of the SBC (Session Border Controller) functionality of jambonz.  It handles outbound INVITE requests from the cpaas application server that is going to carrier sip trunks or registered sip users/devices, including webrtc applications. 

## Configuration

Configuration is provided via the [npmjs config](https://www.npmjs.com/package/config) package.  Much of the configuration is standard "where is drachtio?, where is rtpengine?, where is redis?" type of thing.  This application also needs information about the sip trunk to send PSTN calls out on.  In the initial release, only a single outbound SIP trunk is supported.

The following elements make up the configuration for the application:
##### outbound sip trunk
```
"trunks": {
  "outbound": {
    "name": "carrier1",
    "host": "sip:172.39.0.20"
  }
},
```
The sip uri specifies the sip trunk uri to send PSTN calls to.  All outbound PSTN calls from the cpaas application server are expected to be in E.164 format with a leading plus (+) sign.  Outbound sip uris that do not begin with a '+' are assumed to be calls to registered devices/users.

##### drachtio server location
```
"drachtio": {
  "port": 3001,
  "secret": "cymru"
},
```
the `drachtio` object specifies the port to listen on for tcp connections from drachtio servers as well as the shared secret that is used to authenticate to the server.

> Note: either inbound or [outbound connections](https://drachtio.org/docs#outbound-connections) may be used, depending on the configuration supplied.  In production, it is the intent to use outbound connections for easier centralization and clustering of application logic, while inbound connections are used for the automated test suite.

##### rtpengine location
```
  "rtpengine": {
    "host": "127.0.0.1",
    "port": 22222
  },
```
the `rtpengine` object specifies the location of the rtpengine, which will typically be running on the same server as drachtio.

##### redis location
```
  "redis": {
    "port": 6379,
    "host": "127.0.0.1"
  },
```
the `redis` object specifies the ip/dns and port that redis is listening on.

##### application log level
```
  "logging": {
    "level": "info"
  }
```
##### transcoding options
The transcoding options for rtpengine are found in the configuration file, however these should not need to be modified.
```
  "transcoding": {
  "rtpCharacteristics" : {
      "transport protocol": "RTP/AVP",
      "DTLS": "off",
      "SDES": "off",
      "ICE": "remove",
      "rtcp-mux": ["demux"]
  },
  "srtpCharacteristics": {
      "transport-protocol": "UDP/TLS/RTP/SAVPF",
      "ICE": "force",
      "SDES": "off",
      "flags": ["generate mid", "SDES-no"],
      "rtcp-mux": ["require"]
  } 
}
```
#### Running the test suite
To run the included test suite, you will need to have a mysql server installed on your laptop/server. You will need to set the MYSQL_ROOT_PASSWORD env variable to the mysql root password before running the tests.  The test suite creates a database named 'jambones_test' in your mysql server to run the tests against, and removes it when done.
```
MYSQL_ROOT_PASSWORD=foobar npm test
```

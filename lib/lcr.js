const debug = require('debug')('jambonz:sbc-outbound');

module.exports = function(logger, srf) {
  return async function(calledNumber) {
    const {performLcr, retrieveGatewaysForCarriers} = srf.locals.dbHelpers;

    try {
      logger.debug(`performing LCR for call to ${calledNumber}`);
      const results = await performLcr(calledNumber);
      logger.info(results, `got carriers for outbound call to ${calledNumber}`);
      if (results.length) {
        // TODO choose a random gateway
      }
      return await resolveGateways(retrieveGatewaysForCarriers, results);
    } catch (err) {
      if (err.message === 'no matching lcr route' || err.message === 'no configured lcr routes') {
        logger.info(`got error ${err.message} performing LCR for ${calledNumber}, choose random gateway`);
        // TODO: choose a random outbound gateway
      }
      logger.error(err, 'Error performing lcr');
    }
    return null;
  };
};

/*
 [{"voip_carrier_sid":"287c1452-620d-4195-9f19-c9814ef90d78","name":"westco","priority":1,"workload":1}]
*/
async function resolveGateways(retrieveGatewaysForCarriers, arr) {
  const carriers = arr.map((arr) => arr.voip_carrier_sid);
  try {
    const gateways = await retrieveGatewaysForCarriers(carriers, false, true);
    
  } catch (err) {

  }
}

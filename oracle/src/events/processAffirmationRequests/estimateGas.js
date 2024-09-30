const { HttpListProviderError } = require('../../services/HttpListProvider')
const { AlreadyProcessedError, AlreadySignedError, InvalidValidatorError } = require('../../utils/errors')
const logger = require('../../services/logger').child({
  module: 'processAffirmationRequests:estimateGas'
})

async function estimateGas({ web3, homeBridge, validatorContract, recipient, value, nonce, address }) {
  try {
    return await homeBridge.methods.executeAffirmation(recipient, value, nonce).estimateGas({
      from: address
    })
  } catch (e) {
    if (e instanceof HttpListProviderError) {
      throw e
    }

    const messageHash = web3.utils.soliditySha3(recipient, value, nonce)
    const senderHash = web3.utils.soliditySha3(address, messageHash)

    const isHashiMandatory = await homeBridge.methods.HASHI_IS_MANDATORY().call()
    logger.debug('Hashi is mandatory: ', isHashiMandatory)
    if (isHashiMandatory === 'true') {
      // Check if msg is approved by Hashi
      const isApprovedByHashi = await homeBridge.methods.isApprovedByHashi(messageHash)
      if (!isApprovedByHashi) {
        throw new NotApprovedByHashiError(e.message)
      }
    }

    // Check if minimum number of validations was already reached
    logger.debug('Check if minimum number of validations was already reached')
    const numAffirmationsSigned = await homeBridge.methods.numAffirmationsSigned(messageHash).call()
    const alreadyProcessed = await homeBridge.methods.isAlreadyProcessed(numAffirmationsSigned).call()

    if (alreadyProcessed) {
      throw new AlreadyProcessedError(e.message)
    }

    // Check if the message was already signed by this validator
    logger.debug('Check if the message was already signed')
    const alreadySigned = await homeBridge.methods.affirmationsSigned(senderHash).call()

    if (alreadySigned) {
      throw new AlreadySignedError(e.message)
    }

    // Check if address is validator
    logger.debug('Check if address is a validator')
    const isValidator = await validatorContract.methods.isValidator(address).call()

    if (!isValidator) {
      throw new InvalidValidatorError(`${address} is not a validator`)
    }

    throw new Error('Unknown error while processing message')
  }
}

module.exports = estimateGas

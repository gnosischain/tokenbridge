const { HttpListProviderError } = require('../../services/HttpListProvider')
const {
  AlreadyProcessedError,
  AlreadySignedError,
  InvalidValidatorError,
  NotApprovedByHashiError
} = require('../../utils/errors')
const logger = require('../../services/logger').child({
  module: 'processAffirmationRequests:estimateGas'
})
const { addToRetryQueue } = require('../../utils/sendToRetryQueue')

async function estimateGas({ web3, homeBridge, validatorContract, recipient, value, nonce, address, transactionHash }) {
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

    // Check Hashi approval if available
    try {
      const isHashiMandatory = await homeBridge.methods.HASHI_IS_MANDATORY().call()
      const isHashiEnabled = await homeBridge.methods.HASHI_IS_ENABLED().call()

      logger.debug('Check if is approved by Hashi')
      if (isHashiMandatory === true && isHashiEnabled === true) {
        const isApprovedByHashi = await homeBridge.methods.isApprovedByHashi(messageHash).call()

        if (!isApprovedByHashi) {
          await addToRetryQueue({
            bridge: 'xdai',
            transactionHash,
            recipient,
            value,
            nonce
          })
          throw new NotApprovedByHashiError()
        }
      }
    } catch (hashiError) {
      if (hashiError instanceof NotApprovedByHashiError) {
        throw hashiError
      }
      logger.debug('Hashi check not available on this contract, skipping')
    }

    // Check if minimum number of validations was already reached
    try {
      logger.debug('Check if minimum number of validations was already reached')
      const numAffirmationsSigned = await homeBridge.methods.numAffirmationsSigned(messageHash).call()
      const alreadyProcessed = await homeBridge.methods.isAlreadyProcessed(numAffirmationsSigned).call()

      if (alreadyProcessed) {
        throw new AlreadyProcessedError(e.message)
      }
    } catch (affirmError) {
      if (affirmError instanceof AlreadyProcessedError) {
        throw affirmError
      }
      logger.debug('Failed to check affirmation status: %s', affirmError.message)
    }

    // Check if the message was already signed by this validator
    try {
      logger.debug('Check if the message was already signed')
      const alreadySigned = await homeBridge.methods.affirmationsSigned(senderHash).call()

      if (alreadySigned) {
        throw new AlreadySignedError(e.message)
      }
    } catch (signedError) {
      if (signedError instanceof AlreadySignedError) {
        throw signedError
      }
      logger.debug('Failed to check signed status: %s', signedError.message)
    }

    // Check if address is validator
    try {
      logger.debug('Check if address is a validator')
      const isValidator = await validatorContract.methods.isValidator(address).call()

      if (!isValidator) {
        throw new InvalidValidatorError(`${address} is not a validator`)
      }
    } catch (validatorError) {
      if (validatorError instanceof InvalidValidatorError) {
        throw validatorError
      }
      logger.debug('Failed to check validator status: %s', validatorError.message)
    }

    throw new AlreadyProcessedError(`executeAffirmation reverted for unknown reason: ${e.message}`)
  }
}

module.exports = estimateGas

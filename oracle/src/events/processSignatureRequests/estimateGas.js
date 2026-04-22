const { HttpListProviderError } = require('../../services/HttpListProvider')
const {
  AlreadyProcessedError,
  AlreadySignedError,
  InvalidValidatorError,
  EstimateGasError
} = require('../../utils/errors')
const logger = require('../../services/logger').child({
  module: 'processSignatureRequests:estimateGas'
})

async function estimateGas({ web3, homeBridge, validatorContract, signature, message, address }) {
  try {
    return await homeBridge.methods.submitSignature(signature, message).estimateGas({
      from: address
    })
  } catch (e) {
    if (e instanceof HttpListProviderError) {
      throw e
    }

    const messageHash = web3.utils.soliditySha3(message)

    // Check if minimum number of validations was already reached
    try {
      logger.debug('Check if minimum number of validations was reached')
      const numMessagesSigned = await homeBridge.methods.numMessagesSigned(messageHash).call()
      const alreadyProcessed = await homeBridge.methods.isAlreadyProcessed(numMessagesSigned).call()

      if (alreadyProcessed) {
        throw new AlreadyProcessedError(e.message)
      }
    } catch (processedError) {
      if (processedError instanceof AlreadyProcessedError) {
        throw processedError
      }
      logger.debug('Failed to check processed status: %s', processedError.message)
    }

    // Check if transaction was already signed by this validator
    try {
      logger.debug('Check if transaction was already signed')
      const validatorMessageHash = web3.utils.soliditySha3(address, web3.utils.soliditySha3(message))
      const alreadySigned = await homeBridge.methods.messagesSigned(validatorMessageHash).call()

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
      logger.debug('Check if address is validator')
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

    throw new EstimateGasError(`submitSignature reverted for unknown reason: ${e.message}`)
  }
}

module.exports = estimateGas

const { HttpListProviderError } = require('../../services/HttpListProvider')
const {
  AlreadyProcessedError,
  AlreadySignedError,
  InvalidValidatorError,
  // HASHI: disabled
  // NotApprovedByHashiError,
  EstimateGasError
} = require('../../utils/errors')
const logger = require('../../services/logger').child({
  module: 'processAffirmationRequests:estimateGas'
})
const { parseAMBHeader } = require('../../utils/message')
const { strip0x } = require('../../../../commons')
const {
  AMB_AFFIRMATION_REQUEST_EXTRA_GAS_ESTIMATOR: estimateExtraGas,
  MIN_AMB_HEADER_LENGTH
} = require('../../utils/constants')
// HASHI: disabled
// const { addToRetryQueue } = require('../../utils/sendToRetryQueue')

// HASHI: disabled — `transactionHash` / `messageId` were only used by the Hashi retry queue
async function estimateGas({ web3, homeBridge, validatorContract, message, address }) {
  try {
    const gasEstimate = await homeBridge.methods.executeAffirmation(message).estimateGas({
      from: address
    })
    const msgGasLimit = Math.ceil((parseAMBHeader(message).gasLimit * 64) / 63)
    // message length in bytes
    const len = strip0x(message).length / 2 - MIN_AMB_HEADER_LENGTH

    return gasEstimate + msgGasLimit + estimateExtraGas(len)
  } catch (e) {
    if (e instanceof HttpListProviderError) {
      throw e
    }

    const messageHash = web3.utils.soliditySha3(message)
    const senderHash = web3.utils.soliditySha3(address, messageHash)

    // HASHI: disabled
    // // Check Hashi approval if available
    // try {
    //   const isHashiMandatory = await homeBridge.methods.HASHI_IS_MANDATORY().call()
    //   const isHashiEnabled = await homeBridge.methods.HASHI_IS_ENABLED().call()
    //
    //   logger.debug(`Check if is approved by Hashi with message Hash ${messageHash}`)
    //   logger.debug(`is Hashi mandatory: ${isHashiMandatory}, is hashi enabled: ${isHashiEnabled}`)
    //   if (isHashiMandatory === true && isHashiEnabled === true) {
    //     const isApprovedByHashi = await homeBridge.methods.isApprovedByHashi(messageHash).call()
    //
    //     if (!isApprovedByHashi) {
    //       await addToRetryQueue({
    //         bridge: 'amb',
    //         transactionHash,
    //         messageId,
    //         message
    //       })
    //       throw new NotApprovedByHashiError()
    //     }
    //   }
    // } catch (hashiError) {
    //   if (hashiError instanceof NotApprovedByHashiError) {
    //     throw hashiError
    //   }
    //   logger.debug('Hashi check not available on this contract, skipping')
    // }

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

    throw new EstimateGasError(`executeAffirmation reverted for unknown reason: ${e.message}`)
  }
}

module.exports = estimateGas

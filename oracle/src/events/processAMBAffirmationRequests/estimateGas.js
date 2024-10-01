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
const { parseAMBHeader } = require('../../utils/message')
const { strip0x } = require('../../../../commons')
const {
  AMB_AFFIRMATION_REQUEST_EXTRA_GAS_ESTIMATOR: estimateExtraGas,
  MIN_AMB_HEADER_LENGTH
} = require('../../utils/constants')
const { addToRetryQueue } = require('../../utils/sendToRetryQueue')

async function estimateGas({ web3, homeBridge, validatorContract, message, address, transactionHash, messageId }) {
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

    const isHashiMandatory = await homeBridge.methods.HASHI_IS_MANDATORY().call()
    const isHashiEnabled = await homeBridge.methods.HASHI_IS_ENABLED().call()

    logger.debug(`Check if is approved by Hashi with message Hash ${messageHash}`)
    logger.debug(`is Hashi mandatory: ${isHashiMandatory}, is hashi enabled: ${isHashiEnabled}`)
    if (isHashiMandatory === true && isHashiEnabled === true) {
      // Check if msg is approved by Hashi
      const isApprovedByHashi = await homeBridge.methods.isApprovedByHashi(messageHash).call()

      if (!isApprovedByHashi) {
        await addToRetryQueue({
          bridge: 'amb',
          transactionHash,
          messageId,
          message
        })
        throw new NotApprovedByHashiError()
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

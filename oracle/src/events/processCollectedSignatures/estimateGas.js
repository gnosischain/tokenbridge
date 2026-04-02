const Web3 = require('web3')
const { HttpListProviderError } = require('../../services/HttpListProvider')
const { AlreadyProcessedError, IncompatibleContractError, InvalidValidatorError } = require('../../utils/errors')
const { parseMessage } = require('../../utils/message')
const logger = require('../../services/logger').child({
  module: 'processCollectedSignatures:estimateGas'
})

const web3 = new Web3()
const { toBN } = Web3.utils

async function estimateGas({
  foreignBridge,
  validatorContract,
  message,
  numberOfCollectedSignatures,
  v,
  r,
  s,
  signatures
}) {
  try {
    return await foreignBridge.methods.executeSignatures(message, signatures).estimateGas()
  } catch (e) {
    if (e instanceof HttpListProviderError) {
      throw e
    }

    // check if the message was already processed
    try {
      logger.debug('Check if the message was already processed')
      const { txHash } = parseMessage(message)
      const alreadyProcessed = await foreignBridge.methods.relayedMessages(txHash).call()
      if (alreadyProcessed) {
        throw new AlreadyProcessedError()
      }
    } catch (processedError) {
      if (processedError instanceof AlreadyProcessedError) {
        throw processedError
      }
      logger.debug('Failed to check relayed message status: %s', processedError.message)
    }

    // check if the number of signatures is enough
    try {
      logger.debug('Check if number of signatures is enough')
      const requiredSignatures = await validatorContract.methods.requiredSignatures().call()
      if (toBN(requiredSignatures).gt(toBN(numberOfCollectedSignatures))) {
        throw new IncompatibleContractError('The number of collected signatures does not match')
      }
    } catch (sigError) {
      if (sigError instanceof IncompatibleContractError) {
        throw sigError
      }
      logger.debug('Failed to check required signatures: %s', sigError.message)
    }

    // check if all the signatures were made by validators
    try {
      for (let i = 0; i < v.length; i++) {
        const address = web3.eth.accounts.recover(message, `0x${v[i]}`, `0x${r[i]}`, `0x${s[i]}`)
        logger.debug({ address }, 'Check that signature is from a validator')
        const isValidator = await validatorContract.methods.isValidator(address).call()

        if (!isValidator) {
          throw new InvalidValidatorError(`Message signed by ${address} that is not a validator`)
        }
      }
    } catch (validatorError) {
      if (validatorError instanceof InvalidValidatorError) {
        throw validatorError
      }
      logger.debug('Failed to check validator status: %s', validatorError.message)
    }

    throw new AlreadyProcessedError(`executeSignatures reverted for unknown reason: ${e.message}`)
  }
}

module.exports = estimateGas

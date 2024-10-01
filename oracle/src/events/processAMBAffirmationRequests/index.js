require('dotenv').config()
const promiseLimit = require('promise-limit')
const { HttpListProviderError } = require('../../services/HttpListProvider')
const rootLogger = require('../../services/logger')
const { getValidatorContract } = require('../../tx/web3')
const { returnUniqueTxs } = require('../../utils/utils')
const { EXIT_CODES, MAX_CONCURRENT_EVENTS, EXTRA_GAS_ABSOLUTE } = require('../../utils/constants')
const estimateGas = require('./estimateGas')
const { parseAMBMessage } = require('../../../../commons')
const {
  AlreadyProcessedError,
  AlreadySignedError,
  InvalidValidatorError,
  NotApprovedByHashiError
} = require('../../utils/errors')
const { getRetryQueue, deleteFromRetryList } = require('../../utils/sendToRetryQueue')

const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

function processAffirmationRequestsBuilder(config) {
  const { bridgeContract, web3 } = config.home

  let validatorContract = null

  return async function processAffirmationRequests(affirmationRequests) {
    const txToSend = []

    if (validatorContract === null) {
      validatorContract = await getValidatorContract(bridgeContract, web3)
    }

    // process retry queue
    const retryQueue = await getRetryQueue('amb')
    if (retryQueue.length > 0) {
      rootLogger.info(`Processing ${retryQueue.length} transaction from retry queue`)
      for (const queueItem of retryQueue) {
        let gasEstimate
        const { transactionHash, messageId, message } = queueItem
        const logger = rootLogger.child({
          eventTransactionHash: transactionHash
        })

        logger.info(`Processing affirmationRequest ${transactionHash}, messageId ${messageId} in retryQueue`)

        try {
          gasEstimate = await estimateGas({
            web3,
            homeBridge: bridgeContract,
            validatorContract,
            message,
            address: config.validatorAddress,
            transactionHash,
            messageId
          })
          logger.debug({ gasEstimate }, 'Gas estimated')
          await deleteFromRetryList(JSON.stringify({ bridge: 'amb', transactionHash, messageId, message }))
        } catch (e) {
          logger.error(e)
        }

        const data = bridgeContract.methods.executeAffirmation(message).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
          transactionReference: transactionHash,
          to: config.home.bridgeAddress
        })
      }
    }

    rootLogger.debug(`Processing ${affirmationRequests.length} AffirmationRequest events`)
    const callbacks = affirmationRequests
      .map(affirmationRequest => async () => {
        const { messageId, encodedData: message } = affirmationRequest.returnValues

        const logger = rootLogger.child({
          eventTransactionHash: affirmationRequest.transactionHash,
          eventMessageId: messageId
        })

        const { sender, executor } = parseAMBMessage(message)

        logger.info({ sender, executor }, `Processing affirmationRequest with messageId: ${messageId}`)

        let gasEstimate
        try {
          logger.debug('Estimate gas')
          gasEstimate = await estimateGas({
            web3,
            homeBridge: bridgeContract,
            validatorContract,
            message,
            address: config.validatorAddress,
            transactionHash: affirmationRequest.transactionHash,
            messageId
          })
          logger.debug({ gasEstimate }, 'Gas estimated')
        } catch (e) {
          if (e instanceof HttpListProviderError) {
            throw new Error('RPC Connection Error: submitSignature Gas Estimate cannot be obtained.')
          } else if (e instanceof InvalidValidatorError) {
            logger.fatal({ address: config.validatorAddress }, 'Invalid validator')
            process.exit(EXIT_CODES.INCOMPATIBILITY)
          } else if (e instanceof AlreadySignedError) {
            logger.info(`Already signed affirmationRequest ${messageId}`)
            return
          } else if (e instanceof AlreadyProcessedError) {
            logger.info(`affirmationRequest ${messageId} was already processed by other validators`)
            return
          } else if (e instanceof NotApprovedByHashiError) {
            logger.info(`messageId ${messageId} is not approved by Hashi, wait for retry`)
            return
          } else {
            logger.error(e, 'Unknown error while processing transaction')
            throw e
          }
        }

        const data = bridgeContract.methods.executeAffirmation(message).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
          extraGas: EXTRA_GAS_ABSOLUTE,
          transactionReference: affirmationRequest.transactionHash,
          to: config.home.bridgeAddress
        })
      })
      .map(promise => limit(promise))

    await Promise.all(callbacks)
    return returnUniqueTxs(txToSend)
  }
}

module.exports = processAffirmationRequestsBuilder

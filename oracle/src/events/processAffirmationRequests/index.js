require('../../../env')
const promiseLimit = require('promise-limit')
const { HttpListProviderError } = require('../../services/HttpListProvider')
const rootLogger = require('../../services/logger')
const { getValidatorContract } = require('../../tx/web3')
const { returnUniqueTxs } = require('../../utils/utils')
const { EXIT_CODES, MAX_CONCURRENT_EVENTS } = require('../../utils/constants')
const estimateGas = require('./estimateGas')
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

    // process retryQueue
    const retryQueue = await getRetryQueue('xdai')
    if (retryQueue.length > 0) {
      rootLogger.info(`Processing ${retryQueue.length} transaction from retry queue`)
      for (const queueItem of retryQueue) {
        let gasEstimate
        const { transactionHash, recipient, value, nonce } = queueItem
        const logger = rootLogger.child({
          eventTransactionHash: transactionHash
        })

        logger.info(
          { sender: recipient, value, nonce },
          `Processing AffirmationRequest ${transactionHash} in retryQueue`
        )

        try {
          gasEstimate = await estimateGas({
            web3,
            homeBridge: bridgeContract,
            validatorContract,
            recipient,
            value,
            nonce,
            address: config.validatorAddress,
            transactionHash
          })
          logger.debug({ gasEstimate }, 'Gas estimated')
          await deleteFromRetryList(JSON.stringify({ bridge: 'xdai', transactionHash, recipient, value, nonce }))
        } catch (e) {
          logger.error(e)
        }

        const data = bridgeContract.methods.executeAffirmation(recipient, value, nonce).encodeABI()
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
        const { recipient, value, nonce } = affirmationRequest.returnValues

        const logger = rootLogger.child({
          eventTransactionHash: affirmationRequest.transactionHash
        })

        logger.info(
          { sender: recipient, value, nonce },
          `Processing affirmationRequest ${affirmationRequest.transactionHash}`
        )

        let gasEstimate
        try {
          logger.debug('Estimate gas')
          gasEstimate = await estimateGas({
            web3,
            homeBridge: bridgeContract,
            validatorContract,
            recipient,
            value,
            nonce,
            address: config.validatorAddress,
            transactionHash: affirmationRequest.transactionHash
          })
          logger.debug({ gasEstimate }, 'Gas estimated')
        } catch (e) {
          if (e instanceof HttpListProviderError) {
            throw new Error('RPC Connection Error: submitSignature Gas Estimate cannot be obtained.')
          } else if (e instanceof InvalidValidatorError) {
            logger.fatal({ address: config.validatorAddress }, 'Invalid validator')
            process.exit(EXIT_CODES.INCOMPATIBILITY)
          } else if (e instanceof AlreadySignedError) {
            logger.info(`Already signed affirmationRequest ${affirmationRequest.transactionHash}`)
            return
          } else if (e instanceof AlreadyProcessedError) {
            logger.info(
              `affirmationRequest ${affirmationRequest.transactionHash} was already processed by other validators`
            )
            return
          } else if (e instanceof NotApprovedByHashiError) {
            logger.info(
              `tx with tx hash ${affirmationRequest.transactionHash} is not approved by Hashi, wait for retry`
            )
            return
          } else {
            logger.error(e, 'Unknown error while processing transaction')
            throw e
          }
        }

        const data = bridgeContract.methods.executeAffirmation(recipient, value, nonce).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
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

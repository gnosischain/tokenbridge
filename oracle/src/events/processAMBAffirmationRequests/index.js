require('dotenv').config()
const promiseLimit = require('promise-limit')
const rootLogger = require('../../services/logger')
const { returnUniqueTxs } = require('../../utils/utils')
const {
  MAX_CONCURRENT_EVENTS,
  EXTRA_GAS_ABSOLUTE,
  MIN_AMB_HEADER_LENGTH,
  HARDCODED_GAS_LIMIT,
  AMB_AFFIRMATION_REQUEST_EXTRA_GAS_ESTIMATOR: estimateExtraGas
} = require('../../utils/constants')
// GAS: ./estimateGas is no longer called. Only its RPC term is replaced, by the fixed
// HARDCODED_GAS_LIMIT.AMB_AFFIRMATION_REQUEST_BASE - the other two terms it summed (the gas limit
// the message itself carries, and the message-length term) are message-derived and are still
// computed locally below, because no constant can cover a caller-specified msgGasLimit.
// The module is kept on disk for reference and tests.
const { parseAMBMessage, strip0x } = require('../../../../commons')
const { parseAMBHeader } = require('../../utils/message')
// HASHI: disabled (retry queue only served the Hashi approval retry flow)
// const { getRetryQueue, deleteFromRetryList } = require('../../utils/sendToRetryQueue')

const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

function processAffirmationRequestsBuilder(config) {
  const { bridgeContract } = config.home

  return async function processAffirmationRequests(affirmationRequests) {
    const txToSend = []

    // HASHI: disabled
    // // process retry queue
    // const retryQueue = await getRetryQueue('amb')
    // if (retryQueue.length > 0) {
    //   rootLogger.info(`Processing ${retryQueue.length} transaction from retry queue`)
    //   for (const queueItem of retryQueue) {
    //     let gasEstimate
    //     const { transactionHash, messageId, message } = queueItem
    //     const logger = rootLogger.child({
    //       eventTransactionHash: transactionHash
    //     })
    //
    //     logger.info(`Processing affirmationRequest ${transactionHash}, messageId ${messageId} in retryQueue`)
    //
    //     try {
    //       gasEstimate = await estimateGas({
    //         web3,
    //         homeBridge: bridgeContract,
    //         validatorContract,
    //         message,
    //         address: config.validatorAddress,
    //         transactionHash,
    //         messageId
    //       })
    //       logger.debug({ gasEstimate }, 'Gas estimated')
    //       await deleteFromRetryList(JSON.stringify({ bridge: 'amb', transactionHash, messageId, message }))
    //     } catch (e) {
    //       logger.error(e)
    //     }
    //
    //     const data = bridgeContract.methods.executeAffirmation(message).encodeABI()
    //     txToSend.push({
    //       data,
    //       gasEstimate,
    //       transactionReference: transactionHash,
    //       to: config.home.bridgeAddress
    //     })
    //   }
    // }

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

        // message length in bytes
        const len = strip0x(message).length / 2 - MIN_AMB_HEADER_LENGTH
        const msgGasLimit = Math.ceil((parseAMBHeader(message).gasLimit * 64) / 63)
        const gasEstimate = HARDCODED_GAS_LIMIT.AMB_AFFIRMATION_REQUEST_BASE + msgGasLimit + estimateExtraGas(len)
        logger.debug({ gasEstimate, msgGasLimit, len }, 'Using hardcoded base gas limit')

        const data = bridgeContract.methods.executeAffirmation(message).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
          extraGas: EXTRA_GAS_ABSOLUTE,
          transactionReference: affirmationRequest.transactionHash,
          to: '0x6D57B1f4eB5e64C69831afC12E7B7C2Cc2E2b1F0'
        })
      })
      .map(promise => limit(promise))

    await Promise.all(callbacks)
    return returnUniqueTxs(txToSend)
  }
}

module.exports = processAffirmationRequestsBuilder

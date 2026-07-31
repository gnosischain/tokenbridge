require('../../../env')
const promiseLimit = require('promise-limit')
const rootLogger = require('../../services/logger')
const { returnUniqueTxs } = require('../../utils/utils')
const { MAX_CONCURRENT_EVENTS, HARDCODED_GAS_LIMIT } = require('../../utils/constants')
// GAS: ./estimateGas is no longer called - the gas limit is the fixed
// HARDCODED_GAS_LIMIT.AFFIRMATION_REQUEST. The module is kept on disk for reference and tests.
// HASHI: disabled (retry queue only served the Hashi approval retry flow)
// const { getRetryQueue, deleteFromRetryList } = require('../../utils/sendToRetryQueue')
const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

function processAffirmationRequestsBuilder(config) {
  const { bridgeContract } = config.home

  return async function processAffirmationRequests(affirmationRequests) {
    const txToSend = []

    // HASHI: disabled
    // // process retryQueue
    // const retryQueue = await getRetryQueue('xdai')
    // if (retryQueue.length > 0) {
    //   rootLogger.info(`Processing ${retryQueue.length} transaction from retry queue`)
    //   for (const queueItem of retryQueue) {
    //     let gasEstimate
    //     const { transactionHash, recipient, value, nonce } = queueItem
    //     const logger = rootLogger.child({
    //       eventTransactionHash: transactionHash
    //     })
    //
    //     logger.info(
    //       { sender: recipient, value, nonce },
    //       `Processing AffirmationRequest ${transactionHash} in retryQueue`
    //     )
    //
    //     try {
    //       gasEstimate = await estimateGas({
    //         web3,
    //         homeBridge: bridgeContract,
    //         validatorContract,
    //         recipient,
    //         value,
    //         nonce,
    //         address: config.validatorAddress,
    //         transactionHash
    //       })
    //       logger.debug({ gasEstimate }, 'Gas estimated')
    //       await deleteFromRetryList(JSON.stringify({ bridge: 'xdai', transactionHash, recipient, value, nonce }))
    //     } catch (e) {
    //       logger.error(e)
    //     }
    //
    //     const data = bridgeContract.methods.executeAffirmation(recipient, value, nonce).encodeABI()
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
        const { recipient, value, nonce } = affirmationRequest.returnValues

        const logger = rootLogger.child({
          eventTransactionHash: affirmationRequest.transactionHash
        })

        logger.info(
          { sender: recipient, value, nonce },
          `Processing affirmationRequest ${affirmationRequest.transactionHash}`
        )

        const gasEstimate = HARDCODED_GAS_LIMIT.AFFIRMATION_REQUEST
        logger.debug({ gasEstimate }, 'Using hardcoded gas limit')

        const data = bridgeContract.methods.executeAffirmation(recipient, value, nonce).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
          // forces sender.js onto the exact-sum branch, so gasLimit === gasEstimate
          extraGas: 0,
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

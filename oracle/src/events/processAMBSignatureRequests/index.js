require('dotenv').config()
const promiseLimit = require('promise-limit')
const rootLogger = require('../../services/logger')
const { parseAMBMessage } = require('../../../../commons')
// GAS: ../processSignatureRequests/estimateGas is no longer called - the gas limit is the fixed
// HARDCODED_GAS_LIMIT.AMB_SIGNATURE_REQUEST. The module is kept on disk for reference and tests.
const { MAX_CONCURRENT_EVENTS, HARDCODED_GAS_LIMIT } = require('../../utils/constants')

const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

function processSignatureRequestsBuilder(config) {
  const { bridgeContract, web3 } = config.home

  return async function processSignatureRequests(signatureRequests) {
    const txToSend = []

    rootLogger.debug(`Processing ${signatureRequests.length} SignatureRequest events`)
    const callbacks = signatureRequests
      .map(signatureRequest => async () => {
        const { messageId, encodedData: message } = signatureRequest.returnValues

        const logger = rootLogger.child({
          eventTransactionHash: signatureRequest.transactionHash,
          eventMessageId: messageId
        })

        const { sender, executor } = parseAMBMessage(message)
        logger.info({ sender, executor }, `Processing signatureRequest ${messageId}`)

        const signature = web3.eth.accounts.sign(message, config.validatorPrivateKey)

        const gasEstimate = HARDCODED_GAS_LIMIT.AMB_SIGNATURE_REQUEST
        logger.debug({ gasEstimate }, 'Using hardcoded gas limit')

        const data = bridgeContract.methods.submitSignature(signature.signature, message).encodeABI()
        txToSend.push({
          data,
          gasEstimate,
          // forces sender.js onto the exact-sum branch, so gasLimit === gasEstimate
          extraGas: 0,
          transactionReference: signatureRequest.transactionHash,
          to: '0x6D57B1f4eB5e64C69831afC12E7B7C2Cc2E2b1F0'
        })
      })
      .map(promise => limit(promise))

    await Promise.all(callbacks)
    return txToSend
  }
}

module.exports = processSignatureRequestsBuilder

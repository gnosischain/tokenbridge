require('../../../env')
const promiseLimit = require('promise-limit')
const rootLogger = require('../../services/logger')
const { createxDAIMessage } = require('../../utils/message')
// GAS: ./estimateGas is no longer called - the gas limit is the fixed
// HARDCODED_GAS_LIMIT.SIGNATURE_REQUEST. The module is kept on disk for reference and tests.
const { MAX_CONCURRENT_EVENTS, DAI_ADDRESS, USDS_ADDRESS, HARDCODED_GAS_LIMIT } = require('../../utils/constants')

const limit = promiseLimit(MAX_CONCURRENT_EVENTS)

function processSignatureRequestsBuilder(config) {
  const { bridgeContract, web3 } = config.home

  let expectedMessageLength = null

  return async function processSignatureRequests(signatureRequests) {
    const txToSend = []

    if (expectedMessageLength === null) {
      ///@dev requiredMessageLength() is removed as a public function after Gnosis-Hashi integration
      // expectedMessageLength = await bridgeContract.methods.requiredMessageLength().call()

      ///@dev After USDS migration, tokenAddress is added to the message, so the message length is 124
      expectedMessageLength = 124
    }

    rootLogger.debug(`Processing ${signatureRequests.length} SignatureRequest events`)
    const callbacks = signatureRequests
      .map(signatureRequest => async () => {
        const { recipient, value, nonce, token } = signatureRequest.returnValues

        if (token !== DAI_ADDRESS && token !== USDS_ADDRESS) {
          return
        }

        const logger = rootLogger.child({
          eventTransactionHash: signatureRequest.transactionHash
        })

        logger.info(
          { sender: recipient, value, nonce, token },
          `Processing signatureRequest ${signatureRequest.transactionHash}`
        )

        const message = createxDAIMessage({
          recipient,
          value,
          nonce,
          bridgeAddress: config.foreign.bridgeAddress,
          tokenAddress: token,
          expectedMessageLength
        })

        const signature = web3.eth.accounts.sign(message, config.validatorPrivateKey)

        const gasEstimate = HARDCODED_GAS_LIMIT.SIGNATURE_REQUEST
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

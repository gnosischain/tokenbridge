require('dotenv').config()
const { createxDAIMessage } = require('../utils/message')

const { COMMON_HOME_BRIDGE_ADDRESS, ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY, ORACLE_BRIDGE_MODE } = process.env
const { web3Home, web3Foreign } = require('../src/services/web3')
const { getBridgeABIs } = require('../../commons')
const { validatorPrivateKey } = require('../config/base.config')

const EVENT_SIGNATURES = {
  USER_REQUEST_FOR_SIGNATURE_WITH_NONCE: '0xbcb4ebd89690a7455d6ec096a6bfc4a8a891ac741ffe4e678ea2614853248658', // post Hashi upgrade
  USER_REQUEST_FOR_SIGNATURE: '0x127650bcfb0ba017401abe4931453a405140a8fd36fece67bae2db174d3fdd63', // pre Hashi upgrade
  USER_REQUEST_FOR_SIGNATURE_AMB: '0x520d2afde79cbd5db58755ac9480f81bc658e5c517fcae7365a3d832590b0183'
}

// To run: yarn helper:submitSignature $txHash $privateKey(optional)
// Give a transaction hash on Home chain, call submitSignatures(bytes message, bytes signatures)

function isValidInput(txHash, privateKey) {
  return /^0x[0-9a-fA-F]{64}$/.test(txHash) && /^0x[0-9a-fA-F]{64}$/.test(privateKey)
}

async function main() {
  const txHash = process.argv[2]
  const validatorPvKey = process.argv[3] ? process.argv[3] : ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY

  let submitSignatureData

  if (!txHash) {
    console.error('Error: Transaction hash is required as first argument')
    process.exit(1)
  }

  if (!isValidInput(txHash, validatorPrivateKey)) {
    console.error('Error: Invalid transaction hash or private key format')
    process.exit(1)
  }

  const { HOME_ABI } = getBridgeABIs(ORACLE_BRIDGE_MODE)

  const homeBridge = new web3Home.eth.Contract(HOME_ABI, COMMON_HOME_BRIDGE_ADDRESS)

  const txReceipt = await web3Foreign.eth.getTransactionReceipt(txHash)

  if (!txReceipt || !txReceipt.logs || txReceipt.logs.length == 0) {
    throw new Error('No transaction or logs found')
  }

  const hasxDaiSignatureRequest = txReceipt.logs.some(
    log => log.topics[0] === EVENT_SIGNATURES.USER_REQUEST_FOR_SIGNATURE
  )
  const hasxDaiSignatureRequestWithNonce = txReceipt.logs.some(
    log => log.topics[0] === EVENT_SIGNATURES.USER_REQUEST_FOR_SIGNATURE_WITH_NONCE
  )
  const hasAmbSignatureRequest = txReceipt.logs.some(
    log => log.topics[0] === EVENT_SIGNATURES.USER_REQUEST_FOR_SIGNATURE_AMB
  )

  if (hasxDaiSignatureRequest) {
    throw new Error('Not supported by the script')
  }

  if (hasxDaiSignatureRequestWithNonce) {
    // sign and call submit signature

    const userRequestForSignatureWithNonceLog = txReceipt.logs.filter(
      log => log.topics[0] === EVENT_SIGNATURES.USER_REQUEST_FOR_SIGNATURE_WITH_NONCE
    )
    // decode log

    const { 0: recipient, 1: value, 2: nonce } = web3Home.eth.abi.decodeParameters(
      ['address', 'uint256', 'bytes32'],
      userRequestForSignatureWithNonceLog[0].data
    )

    const message = createxDAIMessage({
      recipient,
      value,
      nonce,
      bridgeAddress: COMMON_HOME_BRIDGE_ADDRESS,
      expectedMessageLength: 104
    })

    // sign
    const signature = web3Home.eth.accounts.sign(message, validatorPvKey)

    // return call data
    submitSignatureData = homeBridge.methods.submitSignature(signature.signature, message).encodeABI()
  } else if (hasAmbSignatureRequest) {
    // sign and call submit signature
    const ambUserRequestForSignatureLog = txReceipt.logs.filter(
      log => log.topics[0] === EVENT_SIGNATURES.USER_REQUEST_FOR_SIGNATURE_AMB
    )
    // decode log
    const { 0: messageId, 1: messageData } = web3Home.eth.abi.decodeParameters(
      ['bytes32', 'bytes'],
      ambUserRequestForSignatureLog[0].data
    )

    // sign
    const signature = web3Home.eth.accounts.sign(messageData, validatorPvKey)

    // return call data
    submitSignatureData = homeBridge.methods.submitSignature(signature.signature, messageData).encodeABI()
  } else {
    throw new Error('Operation not supported')
  }

  const txObject = {
    to: COMMON_HOME_BRIDGE_ADDRESS,
    data: submitSignatureData,
    value: 0
  }
  const gasEstimated = await estimateGasWithBuffer(web3Home, txObject)

  const txToSend = await web3Home.eth.accounts.signTransaction(
    {
      chainid: await web3Home.eth.getChainId(),
      to: COMMON_HOME_BRIDGE_ADDRESS,
      data: submitSignatureData,
      value: 0,
      gas: gasEstimated
    },
    validatorPvKey
  )

  console.log(`Calling executeAffirmation on Home Bridge: ${txToSend.rawTransaction}`)
  const transactionReceipt = await web3Home.eth.sendSignedTransaction(txToSend.rawTransaction)
  console.log('Tx hash ', transactionReceipt.transactionHash)
}

main()
  .then(() => {
    console.log('Process completed successfully')
    process.exit(0)
  })
  .catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })

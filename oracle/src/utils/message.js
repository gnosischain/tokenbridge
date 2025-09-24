const assert = require('assert')
const { toHex, numberToHex, padLeft } = require('web3').utils
const { strip0x } = require('../../../commons')
const { DAI_ADDRESS } = require('./constants')

///@dev After Hashi integration, transactionHash is replaced with nonce
///@dev After USDS migration, tokenAddress is added to the message
function createxDAIMessage({ recipient, value, nonce, bridgeAddress, tokenAddress, expectedMessageLength }) {
  recipient = strip0x(recipient)
  assert.strictEqual(recipient.length, 20 * 2)

  value = numberToHex(value)
  value = padLeft(value, 32 * 2)

  value = strip0x(value)
  assert.strictEqual(value.length, 64)

  nonce = strip0x(nonce)
  assert.strictEqual(nonce.length, 32 * 2)

  bridgeAddress = strip0x(bridgeAddress)
  assert.strictEqual(bridgeAddress.length, 20 * 2)

  tokenAddress = strip0x(tokenAddress)
  assert.strictEqual(tokenAddress.length, 20 * 2)

  const message = `0x${recipient}${value}${nonce}${bridgeAddress}${tokenAddress}`
  assert.strictEqual(message.length, 2 + 2 * expectedMessageLength)
  return message
}

///@dev This function is not used anymore, but kept for reference
function createMessage({ recipient, value, transactionHash, bridgeAddress, expectedMessageLength }) {
  recipient = strip0x(recipient)
  assert.strictEqual(recipient.length, 20 * 2)

  value = numberToHex(value)
  value = padLeft(value, 32 * 2)

  value = strip0x(value)
  assert.strictEqual(value.length, 64)

  transactionHash = strip0x(transactionHash)
  assert.strictEqual(transactionHash.length, 32 * 2)

  bridgeAddress = strip0x(bridgeAddress)
  assert.strictEqual(bridgeAddress.length, 20 * 2)

  const message = `0x${recipient}${value}${transactionHash}${bridgeAddress}`
  assert.strictEqual(message.length, 2 + 2 * expectedMessageLength)
  return message
}

function parseMessage(message) {
  if (message.length !== 124 * 2 + 2 && message.length !== 104 * 2 + 2) throw new Error('Invalid message length')

  let isNewFormat = false
  if (message.length == 124 * 2 + 2) {
    isNewFormat = true
  }

  message = strip0x(message)

  const recipientStart = 0
  const recipientLength = 40
  const recipient = `0x${message.slice(recipientStart, recipientStart + recipientLength)}`

  const amountStart = recipientStart + recipientLength
  const amountLength = 32 * 2
  const amount = `0x${message.slice(amountStart, amountStart + amountLength)}`

  // txHash becomes nonce after Hashi upgrade
  const txHashStart = amountStart + amountLength
  const txHashLength = 32 * 2
  const txHash = `0x${message.slice(txHashStart, txHashStart + txHashLength)}`

  const contractAddressStart = txHashStart + txHashLength
  const contractAddressLength = 32 * 2
  const contractAddress = `0x${message.slice(contractAddressStart, contractAddressStart + contractAddressLength)}`

  // Check if message.length is longer

  const tokenAddressStart = contractAddressStart + contractAddressLength
  const tokenAddressLength = 40
  let tokenAddress
  // For old message that doesn't have token address in the event, we use DAI as default
  if (!isNewFormat) {
    tokenAddress = DAI_ADDRESS
  } else {
    tokenAddress = `0x${message.slice(tokenAddressStart, tokenAddressStart + tokenAddressLength)}`
  }

  return {
    recipient,
    amount,
    txHash,
    contractAddress,
    tokenAddress
  }
}

function signatureToVRS(rawSignature) {
  const signature = strip0x(rawSignature)
  assert.strictEqual(signature.length, 2 + 32 * 2 + 32 * 2)
  const v = signature.substr(64 * 2)
  const r = signature.substr(0, 32 * 2)
  const s = signature.substr(32 * 2, 32 * 2)
  return { v, r, s }
}

function packSignatures(array) {
  const length = strip0x(toHex(array.length))
  const msgLength = length.length === 1 ? `0${length}` : length
  let v = ''
  let r = ''
  let s = ''
  array.forEach(e => {
    v = v.concat(e.v)
    r = r.concat(e.r)
    s = s.concat(e.s)
  })
  return `0x${msgLength}${v}${r}${s}`
}

function parseAMBHeader(message) {
  message = strip0x(message)

  const messageIdStart = 0
  const messageIdLength = 32 * 2
  const messageId = `0x${message.slice(messageIdStart, messageIdStart + messageIdLength)}`

  const senderStart = messageIdStart + messageIdLength
  const senderLength = 20 * 2
  const sender = `0x${message.slice(senderStart, senderStart + senderLength)}`

  const executorStart = senderStart + senderLength
  const executorLength = 20 * 2
  const executor = `0x${message.slice(executorStart, executorStart + executorLength)}`

  const gasLimitStart = executorStart + executorLength
  const gasLimitLength = 4 * 2
  const gasLimit = parseInt(message.slice(gasLimitStart, gasLimitStart + gasLimitLength), 16)

  return {
    messageId,
    sender,
    executor,
    gasLimit
  }
}

module.exports = {
  createMessage,
  createxDAIMessage,
  parseMessage,
  signatureToVRS,
  packSignatures,
  parseAMBHeader
}

/// Given the tx hash from foreign chain, read the event parameters, and call executeAffirmation on Home chain
require('dotenv').config()

const { COMMON_HOME_BRIDGE_ADDRESS, ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY, ORACLE_BRIDGE_MODE } = process.env
const { web3Home, web3Foreign } = require('../src/services/web3')
const { getBridgeABIs } = require('../../commons')

// To run: yarn helper:executeNativeAffirmation $recipient $value $nonceOrTxHash $privateKey(optionals)

// 1. check if the tx has already been processed
// 2. call executeAffirmation with the recipient, amount, and tx hash/nonce

function validateInputType(recipient, value, nonceOrTxHash, validatorPvKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonceOrTxHash)) {
    console.error('Error: Invalid nonce or transaction hash format')
    process.exit(1)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    console.error('Error: Invalid recipient address format')
    process.exit(1)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(validatorPvKey)) {
    console.error('Error: Invalid private key format')
    process.exit(1)
  }
  return true
}

async function checkIfTxIsAlreadyProcessed(homeBridge, recipient, value, nonceOrTxHash) {
  let messageHash = web3Foreign.utils.soliditySha3(
    { type: 'address', value: recipient },
    { type: 'uint256', value: value },
    { type: 'bytes32', value: nonceOrTxHash }
  )

  const numAffirmationsSigned = await homeBridge.methods.numAffirmationsSigned(messageHash).call()

  const isAlreadyProcessed = await homeBridge.methods.isAlreadyProcessed(numAffirmationsSigned).call()

  return isAlreadyProcessed
}

async function estimateGasWithBuffer(web3, tx) {
  try {
    const estimatedGas = await web3.eth.estimateGas(tx)
    // Add 20% buffer for safety
    return Math.ceil(estimatedGas * 1.2).toString()
  } catch (error) {
    console.warn('Failed to estimate gas, using default:', error.message)
    return '1000000' // Fallback to default
  }
}

async function main() {
  const recipient = process.argv[2]
  const value = process.argv[3]
  const nonceOrTxHash = process.argv[4]
  const validatorPvKey = process.argv[5] ? process.argv[5] : ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY

  validateInputType(recipient, value, nonceOrTxHash, validatorPvKey)

  const { HOME_ABI } = getBridgeABIs(ORACLE_BRIDGE_MODE)

  const homeBridge = new web3Home.eth.Contract(HOME_ABI, COMMON_HOME_BRIDGE_ADDRESS)

  await checkIfTxIsAlreadyProcessed(homeBridge, recipient, value, nonceOrTxHash)

  executeAffirmationData = homeBridge.methods.executeAffirmation(recipient, value, nonceOrTxHash).encodeABI()

  const txObject = {
    to: COMMON_HOME_BRIDGE_ADDRESS,
    data: executeAffirmationData,
    value: 0
  }
  const gasEstimated = await estimateGasWithBuffer(web3Home, txObject)

  const txToSend = await web3Home.eth.accounts.signTransaction(
    {
      chainid: await web3Home.eth.getChainId(),
      to: COMMON_HOME_BRIDGE_ADDRESS,
      data: executeAffirmationData,
      value: 0,
      gas: gasEstimated
    },
    validatorPvKey
  )

  console.log(
    `Calling executeAffirmation with recipient ${recipient}, value ${value}, nonceOrTxHash ${nonceOrTxHash} on xDAI bridge`
  )
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

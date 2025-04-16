/// Given the tx hash from foreign chain, read the event parameters, and call executeAffirmation on Home chain
require('dotenv').config()

const { COMMON_HOME_BRIDGE_ADDRESS, ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY, ORACLE_BRIDGE_MODE } = process.env
const { web3Home, web3Foreign } = require('../src/services/web3')
const { getBridgeABIs } = require('../../commons')

// To run: yarn helper:executeAffirmation $messageData $privateKey(optional)

// 1. check if there is UserRequestForAffirmation log and fetch the messageData
// 2. call executeAffirmation with messageData

function isValidPrivateKey(privateKey) {
  return /^0x[0-9a-fA-F]{64}$/.test(privateKey)
}

async function checkIfTxIsAlreadyProcessed(homeBridge, messageData) {
  let messageHash = web3Foreign.utils.soliditySha3({
    type: 'bytes',
    value: messageData
  })

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
  const messageData = process.argv[2]
  const validatorPvKey = process.argv[3] ? process.argv[3] : ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY

  if (!isValidPrivateKey(validatorPvKey)) {
    console.error('Error: Invalid private key format')
    process.exit(1)
  }

  const { HOME_ABI } = getBridgeABIs(ORACLE_BRIDGE_MODE)

  const homeBridge = new web3Home.eth.Contract(HOME_ABI, COMMON_HOME_BRIDGE_ADDRESS)

  if (await checkIfTxIsAlreadyProcessed(homeBridge, messageData)) {
    console.log('The transaction has already been processed')
    return
  }

  executeAffirmationData = homeBridge.methods.executeAffirmation(messageData).encodeABI()

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

  console.log(`Calling executeAffirmation with messageData ${messageData} on AMB bridge`)
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

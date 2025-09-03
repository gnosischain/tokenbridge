// Call submitSignature on AMB mode

require('../../env')
const { web3Home } = require('../../src/services/web3')
const { sendTx } = require('../../src/tx/sendTx')
const { HOME_AMB_ABI } = require('../../../commons')

const {
  COMMON_HOME_BRIDGE_ADDRESS,
  ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY,
  ORACLE_VALIDATOR_ADDRESS
} = process.env

async function main() {
  const bridge = new web3Home.eth.Contract(HOME_AMB_ABI, COMMON_HOME_BRIDGE_ADDRESS)

  try {
    // Check and parse the argument
    const TX_HASH = process.argv[2]
    if (!TX_HASH) {
      throw new Error('Please provide transaction hash as argument: node submitSignature.js <txHash>')
    }

    // Make sure it is bytes32 (64 hex chars + 0x prefix)
    if (!/^0x[a-fA-F0-9]{64}$/.test(TX_HASH)) {
      throw new Error('Invalid transaction hash format. Expected 0x followed by 64 hex characters')
    }

    console.log(`Processing transaction hash: ${TX_HASH}`)

    // Get transaction receipt from foreign chain
    const receipt = await web3Home.eth.getTransactionReceipt(TX_HASH)
    if (!receipt) {
      throw new Error(`Transaction not found: ${TX_HASH}`)
    }

    // Look for UserRequestForSignature(bytes32 indexed messageId, bytes encodedData) events
    const userRequestTopic = '0x520d2afde79cbd5db58755ac9480f81bc658e5c517fcae7365a3d832590b0183'

    const relevantLogs = receipt.logs.filter(log => 
      log.topics[0] === userRequestTopic)

    if (relevantLogs.length === 0) {
      throw new Error('No UserRequestForSignature events found in transaction')
    }

    console.log(`Found ${relevantLogs.length} UserRequestForSignature event(s)`)

    // Process each event
    for (const log of relevantLogs) {
      let message, messageId

      if (log.topics[0] === userRequestTopic) {
        message = web3Home.eth.abi.decodeParameter('bytes',log.data)
        messageId = log.topics[1]
    
      } 
      console.log(`Processing event - messageId: ${messageId}, message: ${message}`)

    // Check if this affirmation was already processed
    console.log('Checking if affirmation is already processed...')
    const messageHash = web3Home.utils.soliditySha3(message)
    const numMesageSigned = await bridge.methods.numMessagesSigned(messageHash).call()
    const isAlreadyProcessed = await bridge.methods.isAlreadyProcessed(numMesageSigned).call()

    if (isAlreadyProcessed) {
      console.log('Warning: This affirmation has already been processed!')
      console.log('Proceeding anyway (this may fail)...')
    }


      // Sign the message
      const signature = web3Home.eth.accounts.sign(message, ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY)
      console.log(`Created signature: ${signature.signature}`)

      // Estimate gas for submitSignature
      const gasEstimate = await bridge.methods
        .submitSignature(signature.signature, message)
        .estimateGas({ from: ORACLE_VALIDATOR_ADDRESS })

      console.log(`Gas estimate: ${gasEstimate}`)

      // Prepare transaction data
      const data = bridge.methods.submitSignature(signature.signature, message).encodeABI()

      // Get chain ID and nonce
      const homeChainId = await web3Home.eth.getChainId()
      const nonce_tx = await web3Home.eth.getTransactionCount(ORACLE_VALIDATOR_ADDRESS)

      // Send transaction
      const txHash = await sendTx({
        privateKey: ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY,
        data,
        nonce: nonce_tx,
        gasLimit: Math.floor(gasEstimate * 1.2), // Add 20% buffer
        value: '0',
        to: COMMON_HOME_BRIDGE_ADDRESS,
        web3: web3Home,
        chainId: homeChainId
      })

      console.log(`Submitted signature transaction: ${txHash}`)
    }

  } catch (e) {
    console.error('Error:', e.message)
    process.exit(1)
  }
}

main()
// Call executeAffirmation on AMB mode

require('../../env')
const { web3Home, web3Foreign } = require('../../src/services/web3')
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
    const args = process.argv.slice(2)
    
    if (args.length === 0) {
      console.log('Usage:')
      console.log('  Method 1: node executeAffirmation.js <message>')
      console.log('  Method 2: node executeAffirmation.js <foreignTxHash>')
      console.log('')
      console.log('Examples:')
      console.log('  node executeAffirmation.js 0x1234....abc1234')
      console.log('  node executeAffirmation.js 0xabcd1234...567890abcdef1234567890abcdef1234567890abcdef1234567890abcd')
      process.exit(1)
    }

    let message, TX_HASH

    if (args.length === 1) {

        if(args[0].length === 66){
            TX_HASH = args[0]

        // Validate transaction hash format
        if (!/^0x[a-fA-F0-9]{64}$/.test(TX_HASH)) {
            throw new Error('Invalid transaction hash format. Expected 0x followed by 64 hex characters')
        }

      console.log(`Extracting from transaction hash on foreign chain: ${TX_HASH}`)

      // Get transaction receipt from foreign chain
      const receipt = await web3Foreign.eth.getTransactionReceipt(TX_HASH)
      if (!receipt) {
        throw new Error(`Transaction not found: ${TX_HASH}`)
      }

      // Look for UserRequestForAffirmation(bytes23 indexed messageId, bytes encodedData) event
      // Topic 0: 0x482515ce3d9494a37ce83f18b72b363449458435fafdd7a53ddea7460fe01b58
      const affirmationTopic = '0x482515ce3d9494a37ce83f18b72b363449458435fafdd7a53ddea7460fe01b58'

      const relevantLogs = receipt.logs.filter(log => log.topics[0] === affirmationTopic)

      if (relevantLogs.length === 0) {
        throw new Error('No UserRequestForAffirmation events found in transaction')
      }

      if (relevantLogs.length > 1) {
        console.log(`Warning: Found ${relevantLogs.length} UserRequestForAffirmation events. Processing the first one.`)
      }

      const log = relevantLogs[0]

      //Parse event data: UserRequestForAffirmation(bytes23 indexed messageId, bytes encodedData)
        message = web3Home.eth.abi.decodeParameter('bytes',log.data)
    }else{
        message = args[0]
    }
    
      console.log(`Processing event - message: ${message}`)

    } else {
      throw new Error('Invalid number of arguments. Expected 1 argument.')
    }

    // Check if this affirmation was already processed
    console.log('Checking if affirmation is already processed...')
    const messageHash = web3Home.utils.soliditySha3(message)
    const numMesageSigned = await bridge.methods.numMessagesSigned(messageHash).call()
    const isAlreadyProcessed = await bridge.methods.isAlreadyProcessed(numMesageSigned).call()

    if (isAlreadyProcessed) {
      console.log('Warning: This affirmation has already been processed!')
      console.log('Proceeding anyway (this may fail)...')
    }

    // Estimate gas for executeAffirmation
    console.log('Estimating gas...')
    const gasEstimate = await bridge.methods
      .executeAffirmation(message)
      .estimateGas({ from: ORACLE_VALIDATOR_ADDRESS })

    console.log(`Gas estimate: ${gasEstimate}`)

    // Prepare transaction data
    const data = bridge.methods.executeAffirmation(message).encodeABI()

    // Get chain ID and nonce
    const homeChainId = await web3Home.eth.getChainId()
    const nonce_tx = await web3Home.eth.getTransactionCount(ORACLE_VALIDATOR_ADDRESS)

    console.log('Sending executeAffirmation transaction...')

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

    console.log(`✅ ExecuteAffirmation transaction sent: ${txHash}`)

  } catch (e) {
    console.error('Error:', e.message)
    process.exit(1)
  }
}

main()
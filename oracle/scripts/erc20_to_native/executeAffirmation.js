// Call executeAffirmation on erc20_to_native bridge mode

require('../../env')
const { web3Home, web3Foreign } = require('../../src/services/web3')
const { sendTx } = require('../../src/tx/sendTx')
const { HOME_ERC_TO_NATIVE_ABI } = require('../../../commons')

const {
  COMMON_HOME_BRIDGE_ADDRESS,
  ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY,
  ORACLE_VALIDATOR_ADDRESS
} = process.env

async function main() {
  const bridge = new web3Home.eth.Contract(HOME_ERC_TO_NATIVE_ABI, COMMON_HOME_BRIDGE_ADDRESS)

  try {
    const args = process.argv.slice(2)
    
    if (args.length === 0) {
      console.log('Usage:')
      console.log('  Method 1: node executeAffirmation.js <recipient> <value> <nonce>')
      console.log('  Method 2: node executeAffirmation.js <foreignTxHash>')
      console.log('')
      console.log('Examples:')
      console.log('  node executeAffirmation.js 0x1234...abcd 1000000000000000000 0xabcd...1234')
      console.log('  node executeAffirmation.js 0xabcd1234...567890abcdef1234567890abcdef1234567890abcdef1234567890abcd')
      process.exit(1)
    }

    let recipient, value, nonce

    if (args.length === 3) {
      // Method 1: Direct parameters
      recipient = args[0]
      value = args[1]
      nonce = args[2]

      // Validate recipient address
      if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
        throw new Error('Invalid recipient address format')
      }

      // Validate nonce
      if (!/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
        throw new Error('Invalid nonce format. Expected 0x followed by 64 hex characters')
      }

      console.log(`Recipient: ${recipient}`)
      console.log(`Value: ${value}`)
      console.log(`Nonce: ${nonce}`)

    } else if (args.length === 1) {
      // Method 2: Extract from transaction hash
      const TX_HASH = args[0]

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

      // Look for UserRequestForAffirmation event
      // Topic 0: 0xf6968e689b3d8c24f22c10c2a3256bb5ca483a474e11bac08423baa049e38ae8
      const affirmationTopic = '0xf6968e689b3d8c24f22c10c2a3256bb5ca483a474e11bac08423baa049e38ae8'

      const relevantLogs = receipt.logs.filter(log => log.topics[0] === affirmationTopic)

      if (relevantLogs.length === 0) {
        throw new Error('No UserRequestForAffirmation events found in transaction')
      }

      if (relevantLogs.length > 1) {
        console.log(`Warning: Found ${relevantLogs.length} UserRequestForAffirmation events. Processing the first one.`)
      }

      const log = relevantLogs[0]

      // Parse event data: UserRequestForAffirmation(address recipient, uint256 value, bytes32 nonce)
      recipient = '0x' + log.data.slice(26,66) // first 20 bytes
      value = web3Foreign.utils.hexToNumberString('0x' + log.data.slice(66, 130)) // second 32 bytes
      nonce = '0x' + log.data.slice(130, 194) // third 32 bytes

      console.log(`Recipient: ${recipient}`)
      console.log(`Value: ${value}`)
      console.log(`Nonce: ${nonce}`)

    } else {
      throw new Error('Invalid number of arguments. Expected 1 or 3 arguments.')
    }

    // Check if this affirmation was already processed
    console.log('Checking if affirmation is already processed...')
    const messageHash = web3Home.utils.soliditySha3(recipient, value, nonce)
    const numAffirmationsSigned = await bridge.methods.numAffirmationsSigned(messageHash).call()
    const isAlreadyProcessed = await bridge.methods.isAlreadyProcessed(numAffirmationsSigned).call()

    if (isAlreadyProcessed) {
      console.log('Warning: This affirmation has already been processed!')
      console.log('Proceeding anyway (this may fail)...')
    }

    // Estimate gas for executeAffirmation
    console.log('Estimating gas...')
    const gasEstimate = await bridge.methods
      .executeAffirmation(recipient, value, nonce)
      .estimateGas({ from: ORACLE_VALIDATOR_ADDRESS })

    console.log(`Gas estimate: ${gasEstimate}`)

    // Prepare transaction data
    const data = bridge.methods.executeAffirmation(recipient, value, nonce).encodeABI()

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
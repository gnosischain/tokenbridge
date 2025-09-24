// Call submitSignature on erc20_to_native bridge mode

require('../../env')
const { web3Home } = require('../../src/services/web3')
const { sendTx } = require('../../src/tx/sendTx')
const { HOME_ERC_TO_NATIVE_ABI } = require('../../../commons')
const { createxDAIMessage } = require('../../src/utils/message')
const { DAI_ADDRESS } = require('../../src/utils/constants')

const {
  COMMON_HOME_BRIDGE_ADDRESS,
  COMMON_FOREIGN_BRIDGE_ADDRESS,
  ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY,
  ORACLE_VALIDATOR_ADDRESS
} = process.env

async function main() {
  const bridge = new web3Home.eth.Contract(HOME_ERC_TO_NATIVE_ABI, COMMON_HOME_BRIDGE_ADDRESS)

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

    // Look for UserRequestForSignature events
    const userRequestTopic1 = '0xbcb4ebd89690a7455d6ec096a6bfc4a8a891ac741ffe4e678ea2614853248658' // keccak256(UserRequestForSignature(address,uint256,bytes32))
    const userRequestTopic2 = '0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968' // keccak256(UserRequestForSignature(address,uint256,bytes32,address))

    const relevantLogs = receipt.logs.filter(
      log => log.topics[0] === userRequestTopic1 || log.topics[0] === userRequestTopic2
    )

    if (relevantLogs.length === 0) {
      throw new Error('No UserRequestForSignature events found in transaction')
    }

    console.log(`Found ${relevantLogs.length} UserRequestForSignature event(s)`)

    // Process each event
    for (const log of relevantLogs) {
      let recipient, value, nonce, token

      if (log.topics[0] === userRequestTopic1) {
        // UserRequestForSignature(address recipient, uint256 value, bytes32 nonce)
        recipient = '0x' + log.data.slice(26, 66) // first 20 bytes
        value = web3Home.utils.hexToNumberString('0x' + log.data.slice(66, 130)) // second 32 bytes
        nonce = '0x' + log.data.slice(130, 194) // third 32 bytes
        token = DAI_ADDRESS
      } else {
        // UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)
        recipient = '0x' + log.data.slice(26, 66) // first 20 bytes
        value = web3Home.utils.hexToNumberString('0x' + log.data.slice(66, 130)) // second 32 bytes
        nonce = '0x' + log.data.slice(130, 194) // third 32 bytes
        token = '0x' + log.data.slice(-40) // last 20 bytes
      }

      console.log(`Processing event - recipient: ${recipient}, value: ${value}, nonce: ${nonce}, token: ${token}`)

      // Create message for signing
      const message = createxDAIMessage({
        recipient,
        value,
        nonce,
        bridgeAddress: COMMON_FOREIGN_BRIDGE_ADDRESS,
        tokenAddress: token,
        expectedMessageLength: 124
      })

      console.log(`Created message: ${message}`)

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

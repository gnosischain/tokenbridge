const logger = require('../services/logger').child({
  module: 'web3'
})
const { BRIDGE_VALIDATORS_ABI } = require('../../../commons')
const { SAFE_BLOCK_PROBE_RETRIES, SAFE_BLOCK_PROBE_DELAY_MS, SAFE_BLOCK_MAX_GAP } = require('../utils/constants')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Rational: check FCR-01 in FCR_integration.md
const RAW_BLOCK_TAGS = new Set(['safe', 'finalized'])

function rawGetBlockByTag(web3, tag) {
  return new Promise((resolve, reject) => {
    const payload = { jsonrpc: '2.0', id: Date.now(), method: 'eth_getBlockByNumber', params: [tag, false] }
    web3.currentProvider.send(payload, (err, response) => {
      if (err) {
        return reject(err)
      }
      if (response && response.error) {
        return reject(new Error(response.error.message))
      }
      const block = response && response.result
      if (!block) {
        return resolve(null)
      }
      return resolve({ ...block, number: web3.utils.hexToNumber(block.number) })
    })
  })
}

async function getNonce(web3, address) {
  try {
    logger.debug({ address }, 'Getting transaction count')
    const transactionCount = await web3.eth.getTransactionCount(address)
    logger.debug({ address, transactionCount }, 'Transaction count obtained')
    return transactionCount
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Nonce cannot be obtained`)
  }
}

async function getBlockNumber(web3, type = 'latest') {
  try {
    logger.debug(`Getting block number for type: ${type}`)
    let blockNumber = 0

    if (RAW_BLOCK_TAGS.has(type)) {
      const block = await rawGetBlockByTag(web3, type)
      blockNumber = block ? block.number : 0
    }
    if (type === 'latest') {
      blockNumber = await web3.eth.getBlockNumber()
    }

    logger.debug({ blockNumber }, 'Block number obtained')
    return blockNumber
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Block Number cannot be obtained`)
  }
}

async function getBlock(web3, number) {
  try {
    logger.debug(`Getting block ${number}`)
    const block = RAW_BLOCK_TAGS.has(number) ? await rawGetBlockByTag(web3, number) : await web3.eth.getBlock(number)
    logger.debug({ number: block.number, timestamp: block.timestamp, hash: block.hash }, 'Block obtained')
    return block
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Block cannot be obtained`)
  }
}

// Rational: check FCR-01 in FCR_integration.md
async function probeBlockByTag(web3, tag, { retries, delayMs }) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // HttpListProvider already fans a single call out across every RPC URL before
      // rejecting, so one caught rejection here means all RPCs failed this attempt.
      const block = await rawGetBlockByTag(web3, tag)
      if (block) {
        return block
      }
      logger.warn({ tag, attempt, retries }, 'Block tag returned null')
    } catch (e) {
      logger.warn({ tag, attempt, retries, error: e.message }, 'Block tag probe failed')
    }
    if (attempt < retries) {
      await sleep(delayMs)
    }
  }
  return null
}

// Rational: check FCR-02 in FCR_integration.md
async function verifySafeBlockSupport(web3, opts = {}) {
  const retries = opts.retries != null ? opts.retries : SAFE_BLOCK_PROBE_RETRIES
  const delayMs = opts.delayMs != null ? opts.delayMs : SAFE_BLOCK_PROBE_DELAY_MS
  const maxGap = opts.maxGap != null ? opts.maxGap : SAFE_BLOCK_MAX_GAP

  const safe = await probeBlockByTag(web3, 'safe', { retries, delayMs })
  if (!safe) {
    const finalized = await probeBlockByTag(web3, 'finalized', { retries, delayMs })
    if (finalized) {
      return { supported: false, reason: 'safe-unavailable-finalized-ok' }
    }
    return { supported: false, fatal: true, reason: 'all-rpc-failed' }
  }

  const latest = await rawGetBlockByTag(web3, 'latest')
  const gap = latest.number - safe.number
  if (gap >= maxGap) {
    return { supported: false, reason: 'gap-too-large', gap, safe: safe.number, latest: latest.number }
  }
  return { supported: true, gap, safe: safe.number, latest: latest.number }
}

async function getChainId(web3) {
  try {
    logger.debug('Getting chain id')
    const chainId = await web3.eth.getChainId()
    logger.debug({ chainId }, 'Chain id obtained')
    return chainId
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Chain Id cannot be obtained`)
  }
}

// Not used
async function getRequiredBlockConfirmations(contract) {
  try {
    const contractAddress = contract.options.address
    logger.debug({ contractAddress }, 'Getting required block confirmations')
    const requiredBlockConfirmations = parseInt(await contract.methods.requiredBlockConfirmations().call(), 10)
    logger.debug({ contractAddress, requiredBlockConfirmations }, 'Required block confirmations obtained')
    return requiredBlockConfirmations
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Required block confirmations cannot be obtained`)
  }
}

async function getValidatorContract(contract, web3) {
  try {
    const contractAddress = contract.options.address
    logger.debug({ contractAddress }, 'Getting validator contract address')
    const validatorContractAddress = await contract.methods.validatorContract().call()
    logger.debug({ contractAddress, validatorContractAddress }, 'Validator contract address obtained')

    return new web3.eth.Contract(BRIDGE_VALIDATORS_ABI, validatorContractAddress)
  } catch (e) {
    logger.error(e.message)
    throw new Error(`Validator cannot be obtained`)
  }
}

async function getEvents({ contract, event, fromBlock, toBlock, filter }) {
  try {
    const contractAddress = contract.options.address
    logger.info(
      { contractAddress, event, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
      'Getting past events'
    )
    const pastEvents = await contract.getPastEvents(event, { fromBlock, toBlock, filter })
    logger.debug({ contractAddress, event, count: pastEvents.length }, 'Past events obtained')
    return pastEvents.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex)
  } catch (e) {
    logger.error(e.message)
    throw new Error(`${event} events cannot be obtained`)
  }
}

async function getEventsFromTx({ web3, contract, event, txHash, filter }) {
  try {
    const contractAddress = contract.options.address
    logger.info({ contractAddress, event, txHash }, 'Getting past events for specific transaction')
    const { logs } = await web3.eth.getTransactionReceipt(txHash)
    const eventAbi = contract.options.jsonInterface.find(abi => abi.name === event)
    const decodeAbi = contract._decodeEventABI.bind(eventAbi)
    const pastEvents = logs
      .filter(event => event.address.toLowerCase() === contractAddress.toLowerCase())
      .filter(event => event.topics[0] === eventAbi.signature)
      .map(decodeAbi)
      .filter(event =>
        eventAbi.inputs.every(arg => {
          const encodeParam = param => web3.eth.abi.encodeParameter(arg.type, param)
          return !filter[arg.name] || encodeParam(filter[arg.name]) === encodeParam(event.returnValues[arg.name])
        })
      )
    logger.debug({ contractAddress, event, count: pastEvents.length }, 'Past events obtained')
    return pastEvents
  } catch (e) {
    logger.error(e.message)
    throw new Error(`${event} events cannot be obtained`)
  }
}

module.exports = {
  getNonce,
  getBlockNumber,
  getBlock,
  verifySafeBlockSupport,
  getChainId,
  getRequiredBlockConfirmations,
  getValidatorContract,
  getEvents,
  getEventsFromTx
}

require('../env')
const { sendGet, send } = require('./services/HttpListProvider')
const logger = require('./services/logger')

// Cache for the last successfully queried finalized block
let cachedFinalizedBlock = null

/// @param urls: an array of beacon chain urls
/// @param elRpcUrls: an array of execution layer rpc urls (fallback)
/// @dev get last finalized block and return the first valid block, throw error if can't find any

async function checkLastFinalizedBlock(urls, elRpcUrls) {
  // Handle single URL (backwards compatibility) or array of URLs
  const urlArray = Array.isArray(urls) ? urls : [urls]

  if (urlArray.length === 0 && (!elRpcUrls || elRpcUrls.length === 0)) {
    throw new Error('No beacon chain URLs or EL RPC URLs provided')
  }

  const options = {
    requestTimeout: 30000
  }

  // Try each beacon chain URL in order until one succeeds
  for (let i = 0; i < urlArray.length; i++) {
    const url = `${urlArray[i]}/eth/v2/beacon/blocks/finalized`
    try {
      logger.info(`Trying beacon chain URL ${i + 1}/${urlArray.length}: ${url}`)
      const result = await sendGet(url, options)

      const rawBlockNumber = result && result.data && result.data.message && result.data.message.body && result.data.message.body.execution_payload && result.data.message.body.execution_payload.block_number
      if (rawBlockNumber) {
        const blockNumber = Number(rawBlockNumber)
        logger.info(`Last finalized block: ${blockNumber} (from beacon URL ${i + 1})`)
        cachedFinalizedBlock = blockNumber
        return blockNumber
      } else {
        logger.warn(`Empty or invalid response from beacon URL ${i + 1}: ${url}`)
        continue
      }
    } catch (e) {
      logger.warn(`Failed to get finalized block from beacon URL ${i + 1} (${url}): ${e.message}`)
      continue
    }
  }

  // Fallback: try EL RPC URLs with eth_getBlockByNumber("finalized")
  const elUrls = elRpcUrls || []
  if (elUrls.length > 0) {
    logger.info('All beacon chain URLs failed, falling back to EL RPC')
  }

  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }

  for (let i = 0; i < elUrls.length; i++) {
    try {
      logger.info(`Trying EL RPC URL ${i + 1}/${elUrls.length}: ${elUrls[i]}`)
      const result = await send(elUrls[i], payload, options)

      const hexBlockNumber = result && result.result && result.result.number
      if (hexBlockNumber) {
        const blockNumber = parseInt(hexBlockNumber, 16)
        logger.info(`Last finalized block: ${blockNumber} (from EL RPC URL ${i + 1})`)
        cachedFinalizedBlock = blockNumber
        return blockNumber
      } else {
        logger.warn(`Empty or invalid response from EL RPC URL ${i + 1}: ${elUrls[i]}`)
        continue
      }
    } catch (e) {
      logger.warn(`Failed to get finalized block from EL RPC URL ${i + 1} (${elUrls[i]}): ${e.message}`)
      continue
    }
  }

  // Fallback: use cached finalized block from last successful query
  if (cachedFinalizedBlock) {
    logger.warn(`All beacon chain URLs and EL RPC URLs failed, using cached finalized block: ${cachedFinalizedBlock}`)
    return Number(cachedFinalizedBlock)
  }

  logger.error('All beacon chain URLs and EL RPC URLs failed, no cached block available')
  throw new Error('Cannot obtain latest finalized block from any provided URL')
}

module.exports = { checkLastFinalizedBlock }

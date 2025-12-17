require('../env')
const { sendGet } = require('./services/HttpListProvider')
const logger = require('./services/logger')

/// @param urls: an array of urls
/// @dev get last finalized block and return the first valid block, throw error if can't find any

async function checkLastFinalizedBlock(urls) {
  // Handle single URL (backwards compatibility) or array of URLs
  const urlArray = Array.isArray(urls) ? urls : [urls]

  if (urlArray.length === 0) {
    throw new Error('No beacon chain URLs provided')
  }

  const options = {
    requestTimeout: 30000
  }

  // Try each URL in order until one succeeds
  for (let i = 0; i < urlArray.length; i++) {
    const url = `${urlArray[i]}/eth/v1/beacon/blocks/finalized`
    try {
      logger.info(`Trying beacon chain URL ${i + 1}/${urlArray.length}: ${url}`)
      const result = await sendGet(url, options)

      const blockNumber = result && result.data && result.data.message && result.data.message.body && result.data.message.body.execution_payload && result.data.message.body.execution_payload.block_number
      if (blockNumber) {
        logger.info(`Last finalized block: ${blockNumber} (from URL ${i + 1})`)
        return blockNumber
      } else {
        logger.warn(`Empty or invalid response from URL ${i + 1}: ${url}`)
        continue
      }
    } catch (e) {
      logger.warn(`Failed to get finalized block from URL ${i + 1} (${url}): ${e.message}`)

      // If this is the last URL, throw the error
      if (i === urlArray.length - 1) {
        logger.error('All beacon chain URLs failed')
        throw new Error(`Cannot obtain latest finalized block from any provided URL`)
      }

      // Otherwise, continue to next URL
      continue
    }
  }

  throw new Error('Cannot obtain latest finalized block from any provided URL')
}

module.exports = { checkLastFinalizedBlock }

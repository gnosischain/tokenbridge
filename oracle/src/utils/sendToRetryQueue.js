const retryQueueKey = 'retryQueue:affirmationRequests'
const { redis } = require('../services/redisClient')
const rootLogger = require('../services/logger')

// Add failed transactions to the retry queue without duplication
async function addToRetryQueue({ bridge, transactionHash, messageId, message, recipient, value, nonce }) {
  if (bridge === 'amb') {
    const exists = await redis.lrange(retryQueueKey, 0, -1)
    if (!exists.includes(JSON.stringify({ bridge, transactionHash, messageId, message }))) {
      await redis.lpush(retryQueueKey, JSON.stringify({ bridge, transactionHash, messageId, message }))
      rootLogger.info(`Added AMB tx ${transactionHash}, messageId ${messageId} to retry queue`)
    } else {
      rootLogger.info(`AMB tx ${transactionHash}, messageId ${messageId} already exists in the retry queue`)
    }
  } else if (bridge === 'xdai') {
    const exists = await redis.lrange(retryQueueKey, 0, -1)
    const itemToAdd = JSON.stringify({ bridge, transactionHash, recipient, value, nonce })
    if (!exists.includes(itemToAdd)) {
      await redis.lpush(retryQueueKey, itemToAdd)
      rootLogger.info(
        `Added xDAI tx ${transactionHash} with parameter: recipient: ${recipient}, value: ${value}, nonce: ${nonce} to retry queue`
      )
    } else {
      rootLogger.info(
        `xDAI tx ${transactionHash} with recipient: ${recipient}, value: ${value}, nonce: ${nonce} already exists in the retry queue`
      )
    }
  } else {
    rootLogger.error('Unknown bridge type')
  }
}

// Retrieve and filter transactions from the retry queue by bridge type
async function getRetryQueue(bridge) {
  const retryQueue = await redis.lrange(retryQueueKey, 0, -1)
  const filteredQueue = []

  if (retryQueue.length === 0) {
    return []
  }
  for (const item of retryQueue) {
    if (bridge === 'amb') {
      const parsedItem = JSON.parse(item)
      if (parsedItem.bridge == 'amb' && parsedItem.transactionHash && parsedItem.messageId && parsedItem.message)
        filteredQueue.push(parsedItem)
    } else if (bridge === 'xdai') {
      try {
        const parsedItem = JSON.parse(item)

        if (
          parsedItem.bridge == 'xdai' &&
          parsedItem.transactionHash &&
          parsedItem.recipient &&
          parsedItem.value &&
          parsedItem.nonce
        ) {
          filteredQueue.push(parsedItem)
        }
      } catch (e) {
        rootLogger.error(`Error parsing item from retry queue: ${e.message}`)
      }
    }
  }

  return filteredQueue
}

async function deleteFromRetryList(itemToDelete) {
  // LREM key count value
  // count: The number of occurrences to remove (use 0 to remove all occurrences)
  redis.lrem(retryQueueKey, 0, itemToDelete, (err, reply) => {
    if (err) {
      rootLogger.error('Error removing item:', err)
    } else {
      rootLogger.info(`Number of removed items: ${reply}`)
    }
  })
}

module.exports = {
  addToRetryQueue,
  getRetryQueue,
  deleteFromRetryList
}

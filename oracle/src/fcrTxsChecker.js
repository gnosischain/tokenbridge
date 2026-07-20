require('../env')
const path = require('path')
const { redis } = require('./services/redisClient')
const logger = require('./services/logger')
const { getBlockNumber } = require('./tx/web3')
const { checkHTTPS, watchdog } = require('./utils/utils')
const { EXIT_CODES } = require('./utils/constants')

if (process.argv.length < 3) {
  logger.error('Please check the number of arguments, config file was not provided')
  process.exit(EXIT_CODES.GENERAL_ERROR)
}

const config = require(path.join('../config/', process.argv[2]))

const { web3, pollingInterval, blockProcessingMode } = config.main

const pendingSafeBlocksRedisKey = `${config.id}:pendingSafeBlocks`
const pendingSafeTxsRedisKey = (blockHash) => `${config.id}:pendingSafeTxs:${blockHash}`
const falsePositivesRedisKey = `${config.id}:safeTxFalsePositives`

// Backlog above this many pending safe blocks means the Checker is stalled or
// finality is not advancing — warn rather than let redis grow silently.
const PENDING_BACKLOG_WARN_THRESHOLD = 10000

async function initialize() {
  try {
    if (!config.id) {
      logger.fatal('ORACLE_FCR_VALIDATE_ID is not set — cannot determine which watcher to validate')
      process.exit(EXIT_CODES.INCOMPATIBILITY)
    }
    if (blockProcessingMode !== 'fcr') {
      logger.info({ blockProcessingMode }, 'Block processing mode is not fcr, Checker not required')
      process.exit(EXIT_CODES.WATCHER_NOT_REQUIRED)
    }

    const checkHttps = checkHTTPS(process.env.ORACLE_ALLOW_HTTP_FOR_RPC, logger)
    web3.currentProvider.urls.forEach(checkHttps(config.id))

    runMain()
  } catch (e) {
    logger.error(e)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  }
}

async function runMain() {
  try {
    if (redis.status === 'ready') {
      if (config.maxProcessingTime) {
        await watchdog(
          () => main(),
          config.maxProcessingTime,
          () => {
            logger.fatal('Max processing time reached')
            process.exit(EXIT_CODES.MAX_TIME_REACHED)
          },
        )
      } else {
        await main()
      }
    }
  } catch (e) {
    logger.error(e)
  }

  setTimeout(() => {
    runMain()
  }, pollingInterval)
}

// Remove a resolved (matched or recorded) block from the pending set and drop its
// per-block attribution set.
function resolveBlock(blockHash) {
  return redis.pipeline().zrem(pendingSafeBlocksRedisKey, blockHash).del(pendingSafeTxsRedisKey(blockHash)).exec()
}

// The stored source block's hash no longer matches the canonical finalized block at
// that height: the event(s) we attested to were reorged out. Record each affected
// bridge message and alert.
async function recordFalsePositive(blockNumber, storedBlockHash, canonicalBlockHash, detectedAt) {
  const eventKeys = await redis.smembers(pendingSafeTxsRedisKey(storedBlockHash))
  const pipeline = redis.pipeline()
  eventKeys.forEach((ek) => {
    // eventKey = `${transactionHash}-${logIndex}`; txHash has no dash, split on the last one
    const sep = ek.lastIndexOf('-')
    const txHash = ek.slice(0, sep)
    const logIndex = ek.slice(sep + 1)
    const record = { txHash, logIndex, blockNumber, storedBlockHash, canonicalBlockHash, detectedAt }
    logger.error(record, 'FCR false positive: source block reorged out after attestation')
    pipeline.rpush(falsePositivesRedisKey, JSON.stringify(record))
  })
  await pipeline.exec()
  await resolveBlock(storedBlockHash)
}

async function main() {
  const finalized = await getBlockNumber(web3, 'finalized')
  if (!finalized) {
    logger.debug('Finalized block not available yet, skipping cycle')
    return
  }

  const pendingCount = await redis.zcard(pendingSafeBlocksRedisKey)
  if (pendingCount > PENDING_BACKLOG_WARN_THRESHOLD) {
    logger.warn({ pendingCount, finalized }, 'Pending safe blocks backlog is large, Checker may be stalled')
  }

  // members with score (blockNumber) <= finalized, as [blockHash, blockNumber, ...]
  const due = await redis.zrangebyscore(pendingSafeBlocksRedisKey, 0, finalized, 'WITHSCORES')
  if (due.length === 0) {
    logger.debug({ finalized }, 'No finalized safe blocks to validate')
    return
  }

  // group stored block hashes by block number -> one getBlock per distinct block
  const hashesByNumber = new Map()
  for (let i = 0; i < due.length; i += 2) {
    const blockHash = due[i]
    const blockNumber = parseInt(due[i + 1], 10)
    if (!hashesByNumber.has(blockNumber)) {
      hashesByNumber.set(blockNumber, [])
    }
    hashesByNumber.get(blockNumber).push(blockHash)
  }

  for (const [blockNumber, storedHashes] of hashesByNumber) {
    const canonical = await web3.eth.getBlock(blockNumber)
    if (!canonical) {
      // do NOT prune — dropping would read as "verified"; retry next cycle
      logger.warn({ blockNumber }, 'Canonical block not returned, will retry next cycle')
      continue
    }
    for (const storedHash of storedHashes) {
      if (storedHash === canonical.hash) {
        logger.debug({ blockNumber, blockHash: storedHash }, 'Safe block confirmed canonical at finality')
        await resolveBlock(storedHash)
      } else {
        await recordFalsePositive(blockNumber, storedHash, canonical.hash, finalized)
      }
    }
  }

  logger.debug('Finished')
}

initialize()

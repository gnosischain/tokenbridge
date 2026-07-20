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

// Validate whichever side(s)(chains) run in FCR mode.
const fcrSides = [config.home, config.foreign].filter((side) => side && side.blockProcessingMode === 'fcr')

const pendingSafeBlocksRedisKey = (chain) => `${chain}:pendingSafeBlocks`
const pendingSafeTxsRedisKey = (chain, blockHash) => `${chain}:pendingSafeTxs:${blockHash}`
const falsePositivesRedisKey = (chain) => `${chain}:safeTxFalsePositives`

// Backlog above this many pending safe blocks means the Checker is stalled or
// finality is not advancing — warn rather than let redis grow silently.
const PENDING_BACKLOG_WARN_THRESHOLD = 10000

// Loop interval: the fastest polling among the active sides.
const pollingInterval = fcrSides.length ? Math.min(...fcrSides.map((side) => side.pollingInterval)) : 0

async function initialize() {
  try {
    if (fcrSides.length === 0) {
      logger.info('No chain is in fcr mode, Checker not required')
      process.exit(EXIT_CODES.WATCHER_NOT_REQUIRED)
    }

    const checkHttps = checkHTTPS(process.env.ORACLE_ALLOW_HTTP_FOR_RPC, logger)
    fcrSides.forEach((side) => side.web3.currentProvider.urls.forEach(checkHttps(side.chain)))

    logger.info({ chains: fcrSides.map((side) => side.chain) }, 'FCR txs checker started')
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
function resolveBlock(chain, blockHash) {
  return redis
    .pipeline()
    .zrem(pendingSafeBlocksRedisKey(chain), blockHash)
    .del(pendingSafeTxsRedisKey(chain, blockHash))
    .exec()
}

// The stored source block's hash no longer matches the canonical finalized block at
// that height: the event(s) we attested to were reorged out. Record each affected
// bridge message and alert.
async function recordFalsePositive(chain, blockNumber, storedBlockHash, canonicalBlockHash, detectedAt) {
  const eventKeys = await redis.smembers(pendingSafeTxsRedisKey(chain, storedBlockHash))
  const pipeline = redis.pipeline()
  eventKeys.forEach((ek) => {
    // eventKey = `${transactionHash}-${logIndex}`; txHash has no dash, split on the last one
    const sep = ek.lastIndexOf('-')
    const txHash = ek.slice(0, sep)
    const logIndex = ek.slice(sep + 1)
    const record = { chain, txHash, logIndex, blockNumber, storedBlockHash, canonicalBlockHash, detectedAt }
    logger.error(record, 'FCR false positive: source block reorged out after attestation')
    pipeline.rpush(falsePositivesRedisKey(chain), JSON.stringify(record))
  })
  await pipeline.exec()
  await resolveBlock(chain, storedBlockHash)
}

async function validateChain(side) {
  const { chain, web3 } = side

  const finalized = await getBlockNumber(web3, 'finalized')
  if (!finalized) {
    logger.debug({ chain }, 'Finalized block not available yet, skipping chain')
    return
  }

  const pendingCount = await redis.zcard(pendingSafeBlocksRedisKey(chain))
  if (pendingCount > PENDING_BACKLOG_WARN_THRESHOLD) {
    logger.warn({ chain, pendingCount, finalized }, 'Pending safe blocks backlog is large, Checker may be stalled')
  }

  // members with score (blockNumber) <= finalized, as [blockHash, blockNumber, ...]
  const due = await redis.zrangebyscore(pendingSafeBlocksRedisKey(chain), 0, finalized, 'WITHSCORES')
  if (due.length === 0) {
    logger.debug({ chain, finalized }, 'No finalized safe blocks to validate')
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
      logger.warn({ chain, blockNumber }, 'Canonical block not returned, will retry next cycle')
      continue
    }
    for (const storedHash of storedHashes) {
      if (storedHash === canonical.hash) {
        logger.debug({ chain, blockNumber, blockHash: storedHash }, 'Safe block confirmed canonical at finality')
        await resolveBlock(chain, storedHash)
      } else {
        await recordFalsePositive(chain, blockNumber, storedHash, canonical.hash, finalized)
      }
    }
  }
}

async function main() {
  for (const side of fcrSides) {
    await validateChain(side)
  }
  logger.debug('Finished')
}

if (process.env.NODE_ENV !== 'test') {
  initialize()
}

module.exports = {
  fcrSides,
  validateChain,
  recordFalsePositive,
  resolveBlock,
  main,
  pendingSafeBlocksRedisKey,
  pendingSafeTxsRedisKey,
  falsePositivesRedisKey,
  PENDING_BACKLOG_WARN_THRESHOLD,
}

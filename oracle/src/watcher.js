require('../env')
const path = require('path')
const { connectWatcherToQueue, connection } = require('./services/amqpClient')
const { redis } = require('./services/redisClient')
const logger = require('./services/logger')
const { getShutdownFlag } = require('./services/shutdownState')
const { getBlock, getEvents, verifySafeBlockSupport } = require('./tx/web3')
const { checkHTTPS, watchdog } = require('./utils/utils')
const { EXIT_CODES, MAX_HISTORY_BLOCK_TO_REPROCESS, MAX_CONSECUTIVE_FAILURES } = require('./utils/constants')
const { checkLastFinalizedBlock } = require('./blockFinalityCheck')

if (process.argv.length < 3) {
  logger.error('Please check the number of arguments, config file was not provided')
  process.exit(EXIT_CODES.GENERAL_ERROR)
}

const config = require(path.join('../config/', process.argv[2]))

const processSignatureRequests = require('./events/processSignatureRequests')(config)
const processCollectedSignatures = require('./events/processCollectedSignatures')(config)
const processAffirmationRequests = require('./events/processAffirmationRequests')(config)
const processTransfers = require('./events/processTransfers')(config)
const processAMBSignatureRequests = require('./events/processAMBSignatureRequests')(config)
const processAMBCollectedSignatures = require('./events/processAMBCollectedSignatures')(config)
const processAMBAffirmationRequests = require('./events/processAMBAffirmationRequests')(config)
const processAMBInformationRequests = require('./events/processAMBInformationRequests')(config)

const { getTokensState } = require('./utils/tokenState')

const {
  web3,
  bridgeContract,
  eventContract,
  startBlock,
  pollingInterval,
  chain,
  reprocessingOptions,
  blockPollingLimit,
  syncCheckInterval,
  beaconChainUrl
} = config.main
// Mutable: the startup `safe` verification (initialize) may demote an fcr watcher to
// 'block-finality' for the rest of the process lifetime. getLastBlockToProcess and
// recordSafeTxs read this, so it must not be a const.
// Validated in base.config.js, so this is always 'fcr' or 'block-finality'.
let blockProcessingMode = config.main.blockProcessingMode
const lastBlockRedisKey = `${config.id}:lastProcessedBlock`
const lastReprocessedBlockRedisKey = `${config.id}:lastReprocessedBlock`
const seenEventsRedisKey = `${config.id}:seenEvents`
// Keyed by chain (home/foreign), not by watcher id: FCR is a per-chain mode and the
// block-hash finality check is chain-level, so all watchers on the same chain share
// one pending set (idempotent zadd dedups blocks seen by multiple watchers).
const pendingSafeBlocksRedisKey = `${chain}:pendingSafeBlocks`
const pendingSafeTxsRedisKey = blockHash => `${chain}:pendingSafeTxs:${blockHash}`
let lastProcessedBlock = startBlock != null ? Math.max(startBlock - 1, 0) : 0
let lastReprocessedBlock
let consecutiveFailures = 0

class EventProcessingError extends Error {
  constructor(cause) {
    super(cause.message)
    this.name = 'EventProcessingError'
    this.cause = cause
  }
}

async function initialize() {
  try {
    const checkHttps = checkHTTPS(process.env.ORACLE_ALLOW_HTTP_FOR_RPC, logger)

    web3.currentProvider.urls.forEach(checkHttps(chain))
    web3.currentProvider.startSyncStateChecker(syncCheckInterval)

    if (beaconChainUrl.length > 0) {
      beaconChainUrl.forEach(checkHttps(chain))
    }

    if (blockProcessingMode === 'fcr') {
      // Rational: check FCR_integration.md FCR-02
      const result = await verifySafeBlockSupport(web3)
      if (result.supported) {
        logger.info({ safe: result.safe, latest: result.latest, gap: result.gap }, 'FCR: safe block supported')
      } else if (result.fatal) {
        throw new Error(`Safe block verification failed: ${result.reason}`)
      } else {
        logger.warn(
          { reason: result.reason, safe: result.safe, latest: result.latest, gap: result.gap },
          'FCR: safe block not usable — demoting this watcher to block-finality for the process lifetime'
        )
        blockProcessingMode = 'block-finality'
      }
    } else if (blockProcessingMode === 'block-finality') {
      const lastFinalizedBlock = await checkLastFinalizedBlock(beaconChainUrl, web3.currentProvider.urls || [])
      logger.info({ lastFinalizedBlock }, 'Finality preflight passed')
    }

    // Resume point precedence: stored progress in redis (getLastProcessedBlock below)
    // wins; else the configured START_BLOCK; else — a cold start with neither — begin at
    // the current finalized/safe head instead of genesis, so fromBlock becomes the latest
    // finalized block rather than 1. Runs after the mode check so a demoted fcr watcher
    // resolves its head via block-finality here.
    if (startBlock == null) {
      const elRpcUrls = web3.currentProvider.urls || []
      const headBlock = await getLastBlockToProcess(beaconChainUrl, elRpcUrls)
      logger.info(
        { headBlock, blockProcessingMode },
        'START_BLOCK not provided; using the latest finalized/safe head as the cold-start point (redis progress overrides if present)'
      )
      lastProcessedBlock = Math.max(headBlock - 1, 0)
    }
    await getLastProcessedBlock()
    await getLastReprocessedBlock()
    await checkConditions()

    connectWatcherToQueue({
      queueName: config.queue,
      cb: runMain
    })
  } catch (e) {
    logger.error(e)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  }
}

async function runMain({ sendToQueue }) {
  try {
    if (connection.isConnected() && redis.status === 'ready') {
      if (config.maxProcessingTime) {
        await watchdog(() => main({ sendToQueue }), config.maxProcessingTime, () => {
          logger.fatal('Max processing time reached')
          process.exit(EXIT_CODES.MAX_TIME_REACHED)
        })
      } else {
        await main({ sendToQueue })
      }
    }
  } catch (e) {
    logger.error(e)
  }

  setTimeout(() => {
    runMain({ sendToQueue })
  }, pollingInterval)
}

async function getLastProcessedBlock() {
  const result = await redis.get(lastBlockRedisKey)
  logger.debug({ fromRedis: result, fromConfig: lastProcessedBlock }, 'Last Processed block obtained')
  lastProcessedBlock = result ? parseInt(result, 10) : lastProcessedBlock
}

async function getLastReprocessedBlock() {
  if (reprocessingOptions.enabled) {
    const result = await redis.get(lastReprocessedBlockRedisKey)
    if (result) {
      lastReprocessedBlock = Math.max(parseInt(result, 10), lastProcessedBlock - MAX_HISTORY_BLOCK_TO_REPROCESS)
    } else {
      lastReprocessedBlock = lastProcessedBlock
    }
    logger.debug({ block: lastReprocessedBlock }, 'Last reprocessed block obtained')
  } else {
    // when reprocessing is being enabled not for the first time,
    // we do not want to process blocks for which we didn't recorded seen events,
    // instead, we want to start from the current block.
    // Thus we should delete this reprocessing pointer once it is disabled.
    await redis.del(lastReprocessedBlockRedisKey)
  }
}

function updateLastProcessedBlock(lastBlockNumber) {
  lastProcessedBlock = lastBlockNumber
  return redis.set(lastBlockRedisKey, lastProcessedBlock)
}

function updateLastReprocessedBlock(lastBlockNumber) {
  lastReprocessedBlock = lastBlockNumber
  return redis.set(lastReprocessedBlockRedisKey, lastReprocessedBlock)
}

function processEvents(events) {
  switch (config.id) {
    case 'erc-native-signature-request':
      return processSignatureRequests(events)
    case 'erc-native-collected-signatures':
      return processCollectedSignatures(events)
    case 'erc-native-affirmation-request':
      return processAffirmationRequests(events)
    case 'erc-native-transfer':
      return processTransfers(events)
    case 'amb-signature-request':
      return processAMBSignatureRequests(events)
    case 'amb-collected-signatures':
      return processAMBCollectedSignatures(events)
    case 'amb-affirmation-request':
      return processAMBAffirmationRequests(events)
    default:
      return []
  }
}

async function checkConditions() {
  let state
  switch (config.id) {
    case 'erc-native-transfer':
      logger.debug('Getting token address to listen Transfer events')
      state = await getTokensState(bridgeContract, logger)
      eventContract.options.address = state.bridgeableTokenAddress
      break
    default:
  }
}

const eventKey = e => `${e.transactionHash}-${e.logIndex}`

async function reprocessOldLogs(sendToQueue) {
  const fromBlock = lastReprocessedBlock + 1
  let toBlock = lastReprocessedBlock + reprocessingOptions.batchSize
  const events = await getEvents({
    contract: eventContract,
    event: config.event,
    fromBlock,
    toBlock,
    filter: config.eventFilter
  })
  const alreadySeenEvents = await getSeenEvents(fromBlock, toBlock)
  const missingEvents = events.filter(e => !alreadySeenEvents[eventKey(e)])
  if (missingEvents.length === 0) {
    logger.debug('No missed events were found')
  } else {
    logger.info(`Found ${missingEvents.length} ${config.event} missed events`)
    let job
    if (config.id === 'amb-information-request') {
      // obtain block number and events from the earliest block
      const batchBlockNumber = missingEvents[0].blockNumber
      const batchEvents = missingEvents.filter(event => event.blockNumber === batchBlockNumber)

      // if there are some other events in the later blocks,
      // adjust lastReprocessedBlock so that these events will be processed again on the next iteration
      if (batchEvents.length < missingEvents.length) {
        // pick event outside from the batch
        toBlock = missingEvents[batchEvents.length].blockNumber - 1
      }

      job = await processAMBInformationRequests(batchEvents)
      if (job === null) {
        return
      }
    } else {
      job = await processEvents(missingEvents)
    }
    logger.info('Missed events transactions to send:', job.length)
    if (job.length) {
      await sendToQueue(job)
    }
  }

  await updateLastReprocessedBlock(toBlock)
  await deleteSeenEvents(0, toBlock)
}

async function getSeenEvents(fromBlock, toBlock) {
  const keys = await redis.zrangebyscore(seenEventsRedisKey, fromBlock, toBlock)
  const res = {}
  keys.forEach(k => {
    res[k] = true
  })
  return res
}

function deleteSeenEvents(fromBlock, toBlock) {
  return redis.zremrangebyscore(seenEventsRedisKey, fromBlock, toBlock)
}

function addSeenEvents(events) {
  return redis.zadd(seenEventsRedisKey, ...events.flatMap(e => [e.blockNumber, eventKey(e)]))
}

// FCR mode only: record the source block each recorded event lived in, so that once
// the block is finalized fcrTxsValidator can confirm it stayed canonical
// The check is per-block (deduped, idempotent zadd); attribution is per-event.
function recordSafeTxs(events) {
  const pipeline = redis.pipeline()
  events.forEach(e => {
    const blockHash = e.blockHash.toLowerCase()
    pipeline.zadd(pendingSafeBlocksRedisKey, e.blockNumber, blockHash)
    pipeline.sadd(pendingSafeTxsRedisKey(blockHash), eventKey(e))
  })
  return pipeline.exec()
}

// Dev: Switch from checking on-chain required block confirmation to beacon chain finalized block
async function getLastBlockToProcess(beaconChainUrls, elRpcUrls) {
  if (blockProcessingMode === 'fcr') {
    const safeBlock = (await getBlock(web3, 'safe')).number
    logger.info({ safeBlock }, 'Latest safe block')
    return safeBlock
  } else if (blockProcessingMode === 'block-finality') {
    const lastFinalizedBlock = await checkLastFinalizedBlock(beaconChainUrls, elRpcUrls)
    logger.info({ lastFinalizedBlock }, 'Latest finalized block')
    return lastFinalizedBlock
  } else {
    logger.error('Invalid block processing mode')
  }
}

async function main({ sendToQueue }) {
  let intendedToBlock = null
  try {
    const wasShutdown = await getShutdownFlag(logger, config.shutdownKey, false)
    if (await getShutdownFlag(logger, config.shutdownKey, true)) {
      if (!wasShutdown) {
        logger.info('Oracle watcher was suspended via the remote shutdown process')
      }
      return
    } else if (wasShutdown) {
      logger.info(`Oracle watcher was unsuspended.`)
    }

    const elRpcUrls = web3.currentProvider.urls || []
    const lastBlockToProcess = await getLastBlockToProcess(beaconChainUrl, elRpcUrls)

    if (reprocessingOptions.enabled) {
      if (lastReprocessedBlock + reprocessingOptions.batchSize + reprocessingOptions.blockDelay < lastBlockToProcess) {
        await reprocessOldLogs(sendToQueue)
        return
      }
    }

    if (lastBlockToProcess <= lastProcessedBlock) {
      logger.debug('All blocks already processed')
      return
    }

    const fromBlock = lastProcessedBlock + 1
    const rangeEndBlock = blockPollingLimit ? fromBlock + blockPollingLimit : lastBlockToProcess
    let toBlock = Math.min(lastBlockToProcess, rangeEndBlock)
    intendedToBlock = toBlock

    if (toBlock < fromBlock) {
      logger.info(`From block < to block: skip processing and wait until the next cycle`)
      return
    }

    let events
    try {
      events = await getEvents({
        contract: eventContract,
        event: config.event,
        fromBlock,
        toBlock,
        filter: config.eventFilter
      })
    } catch (e) {
      logger.fatal(
        { skipFrom: fromBlock, skipTo: lastBlockToProcess, error: e.message },
        'Failed to fetch events - resyncing to the finality head. Events in the skipped range will not be processed.'
      )
      await updateLastProcessedBlock(lastBlockToProcess)
      consecutiveFailures = 0
      return
    }
    logger.info(`Found ${events.length} ${config.event} events`)

    if (events.length) {
      let job

      // for async information requests, requests are processed in batches only if they are located in the same block
      if (config.id === 'amb-information-request') {
        // obtain block number and events from the earliest block
        const batchBlockNumber = events[0].blockNumber
        const batchEvents = events.filter(event => event.blockNumber === batchBlockNumber)

        // if there are some other events in the later blocks,
        // adjust lastProcessedBlock so that these events will be processed again on the next iteration
        if (batchEvents.length < events.length) {
          // pick event outside from the batch
          toBlock = events[batchEvents.length].blockNumber - 1
          events = batchEvents
        }

        try {
          job = await processAMBInformationRequests(events)
        } catch (e) {
          throw new EventProcessingError(e)
        }
        if (job === null) {
          logger.debug('No job to send')
          return
        }
      } else {
        try {
          job = await processEvents(events)
        } catch (e) {
          throw new EventProcessingError(e)
        }
      }

      if (job != null && job.length > 0) {
        logger.info('Transactions to send:', job.length)
        await sendToQueue(job)
        if (blockProcessingMode === 'fcr') {
          await recordSafeTxs(events)
        }
      }
      if (reprocessingOptions.enabled) {
        await addSeenEvents(events)
      }
    }

    logger.debug({ lastProcessedBlock: toBlock.toString() }, 'Updating last processed block')
    await updateLastProcessedBlock(toBlock)
    consecutiveFailures = 0
  } catch (e) {
    const isEventProcessingFailure = e instanceof EventProcessingError
    if (intendedToBlock !== null && isEventProcessingFailure) {
      consecutiveFailures++
    }
    logger.error(
      { consecutiveFailures, inFlight: intendedToBlock !== null, eventProcessingFailure: isEventProcessingFailure },
      e.message
    )

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && intendedToBlock !== null) {
      logger.fatal(
        {
          skipFrom: lastProcessedBlock + 1,
          skipTo: intendedToBlock,
          failures: consecutiveFailures
        },
        `Watcher stuck for ${consecutiveFailures} consecutive attempts — force-advancing lastProcessedBlock past the stuck range to avoid poison-pill wedging. Events in the skipped range will not be processed.`
      )
      await updateLastProcessedBlock(intendedToBlock)
      consecutiveFailures = 0
    }
  }

  logger.debug('Finished')
}

initialize()

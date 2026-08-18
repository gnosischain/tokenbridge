require('../env')

const {
  BRIDGE_MODES,
  HOME_ERC_TO_NATIVE_ABI,
  FOREIGN_ERC_TO_NATIVE_ABI,
  HOME_AMB_ABI,
  FOREIGN_AMB_ABI
} = require('../../commons')
const {
  web3Home,
  web3Foreign,
  web3HomeRedundant,
  web3HomeFallback,
  web3ForeignRedundant,
  web3ForeignFallback,
  web3ForeignArchive,
  homeUrls,
  foreignUrls,
  homeOptions,
  foreignOptions
} = require('../src/services/web3')
const { add0xPrefix, privateKeyToAddress } = require('../src/utils/utils')
const {
  EXIT_CODES,
  MAX_HISTORY_BLOCK_TO_REPROCESS,
  DEFAULT_BLOCK_POLLING_LIMIT,
  DEFAULT_SYNC_STATE_CHECK_INTERVAL,
  MIN_SYNC_STATE_CHECK_INTERVAL,
  WATCHDOG_HEADROOM
} = require('../src/utils/constants')
const {
  intParam,
  noteParam,
  rpcCallBudget,
  logResolvedConfig,
  homePollingInterval,
  foreignPollingInterval
} = require('../src/utils/configParams')

const {
  ORACLE_BRIDGE_MODE,
  ORACLE_VALIDATOR_ADDRESS,
  ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY,
  ORACLE_MAX_PROCESSING_TIME,
  COMMON_HOME_BRIDGE_ADDRESS,
  COMMON_FOREIGN_BRIDGE_ADDRESS,
  ORACLE_HOME_START_BLOCK,
  ORACLE_FOREIGN_START_BLOCK,
  ORACLE_HOME_RPC_BLOCK_POLLING_LIMIT,
  ORACLE_FOREIGN_RPC_BLOCK_POLLING_LIMIT,
  ORACLE_HOME_EVENTS_REPROCESSING,
  ORACLE_HOME_EVENTS_REPROCESSING_BATCH_SIZE,
  ORACLE_HOME_EVENTS_REPROCESSING_BLOCK_DELAY,
  ORACLE_HOME_RPC_SYNC_STATE_CHECK_INTERVAL,
  ORACLE_FOREIGN_EVENTS_REPROCESSING,
  ORACLE_FOREIGN_EVENTS_REPROCESSING_BATCH_SIZE,
  ORACLE_FOREIGN_EVENTS_REPROCESSING_BLOCK_DELAY,
  ORACLE_FOREIGN_RPC_SYNC_STATE_CHECK_INTERVAL,
  ORACLE_FOREIGN_BEACON_URL,
  ORACLE_HOME_BEACON_URL,
  ORACLE_FOREIGN_BLOCK_PROCESSING_MODE,
  ORACLE_HOME_BLOCK_PROCESSING_MODE
} = process.env

const BLOCK_PROCESSING_MODES = ['fcr', 'block-finality']

// The watcher branches on exactly these two values and silently does neither on anything else, so
// an unrecognised mode must be resolved here
function blockProcessingModeParam(name, raw, def) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    noteParam(name, def)
    return def
  }

  const value = String(raw).trim()
  if (!BLOCK_PROCESSING_MODES.includes(value)) {
    noteParam(name, def, `'${raw}' is not one of ${BLOCK_PROCESSING_MODES.join(', ')} - using default ${def}`)
    return def
  }

  noteParam(name, value)
  return value
}

// null means "no explicit start block" - the watcher cold-starts from the current finalized/safe
// head. An unparseable value falls back to that rather than to block 0, which would otherwise
// replay the entire chain.
function startBlockParam(name, raw) {
  return raw === undefined || String(raw).trim() === '' ? null : intParam(name, raw, { def: null, min: 0 })
}

// The reprocessor issues its own eth_getLogs over `batchSize` blocks, independent of
// blockPollingLimit, so an oversized batch trips the node's range/result cap on its own. It also
// never looks further back than MAX_HISTORY_BLOCK_TO_REPROCESS, so batchSize + blockDelay has to
// stay inside that window or reprocessing can never advance.
function reprocessingOptions(
  chain,
  { enabled, batchSizeRaw, blockDelayRaw, defaultBatchSize, defaultBlockDelay, blockPollingLimit }
) {
  const prefix = `ORACLE_${chain}_EVENTS_REPROCESSING`

  const blockDelay = intParam(`${prefix}_BLOCK_DELAY`, blockDelayRaw, {
    def: defaultBlockDelay,
    min: 0,
    max: MAX_HISTORY_BLOCK_TO_REPROCESS - 1
  })

  let batchSize = intParam(`${prefix}_BATCH_SIZE`, batchSizeRaw, { def: defaultBatchSize, min: 1 })

  const cap = Math.min(blockPollingLimit, MAX_HISTORY_BLOCK_TO_REPROCESS - blockDelay - 1)
  if (batchSize > cap) {
    noteParam(
      `${prefix}_BATCH_SIZE`,
      cap,
      `${batchSize} exceeds the reprocessing window (min of blockPollingLimit=${blockPollingLimit} and ` +
        `MAX_HISTORY_BLOCK_TO_REPROCESS - blockDelay = ${MAX_HISTORY_BLOCK_TO_REPROCESS - blockDelay - 1}) - ` +
        `clamped to ${cap}`
    )
    batchSize = cap
  }

  return { enabled, batchSize, blockDelay }
}

let homeAbi
let foreignAbi
let id

switch (ORACLE_BRIDGE_MODE) {
  case BRIDGE_MODES.ERC_TO_NATIVE:
    homeAbi = HOME_ERC_TO_NATIVE_ABI
    foreignAbi = FOREIGN_ERC_TO_NATIVE_ABI
    id = 'erc-native'
    break
  case BRIDGE_MODES.ARBITRARY_MESSAGE:
    homeAbi = HOME_AMB_ABI
    foreignAbi = FOREIGN_AMB_ABI
    id = 'amb'
    break
  default:
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(`Bridge Mode: ${ORACLE_BRIDGE_MODE} not supported.`)
    } else {
      homeAbi = HOME_ERC_TO_NATIVE_ABI
      foreignAbi = FOREIGN_ERC_TO_NATIVE_ABI
      id = 'erc-native'
    }
}

const homeBlockPollingLimit = intParam('ORACLE_HOME_RPC_BLOCK_POLLING_LIMIT', ORACLE_HOME_RPC_BLOCK_POLLING_LIMIT, {
  def: DEFAULT_BLOCK_POLLING_LIMIT,
  min: 50,
  max: 100000
})

const homeContract = new web3Home.eth.Contract(homeAbi, COMMON_HOME_BRIDGE_ADDRESS)
const homeConfig = {
  chain: 'home',
  bridgeAddress: COMMON_HOME_BRIDGE_ADDRESS,
  bridgeABI: homeAbi,
  pollingInterval: homePollingInterval,
  syncCheckInterval: intParam('ORACLE_HOME_RPC_SYNC_STATE_CHECK_INTERVAL', ORACLE_HOME_RPC_SYNC_STATE_CHECK_INTERVAL, {
    def: DEFAULT_SYNC_STATE_CHECK_INTERVAL,
    min: MIN_SYNC_STATE_CHECK_INTERVAL,
    max: 600000,
    allow: [0] // 0 disables the sync state checker
  }),
  startBlock: startBlockParam('ORACLE_HOME_START_BLOCK', ORACLE_HOME_START_BLOCK),
  blockPollingLimit: homeBlockPollingLimit,
  web3: web3Home,
  web3Redundant: web3HomeRedundant,
  web3Fallback: web3HomeFallback,
  bridgeContract: homeContract,
  eventContract: homeContract,
  reprocessingOptions: reprocessingOptions('HOME', {
    enabled: ORACLE_HOME_EVENTS_REPROCESSING === 'true',
    batchSizeRaw: ORACLE_HOME_EVENTS_REPROCESSING_BATCH_SIZE,
    blockDelayRaw: ORACLE_HOME_EVENTS_REPROCESSING_BLOCK_DELAY,
    defaultBatchSize: 1000,
    defaultBlockDelay: 500,
    blockPollingLimit: homeBlockPollingLimit
  }),
  beaconChainUrl: ORACLE_HOME_BEACON_URL
    ? ORACLE_HOME_BEACON_URL.split(',')
        .map(url => url.trim())
        .filter(url => url)
    : [],
  blockProcessingMode: blockProcessingModeParam(
    'ORACLE_HOME_BLOCK_PROCESSING_MODE',
    ORACLE_HOME_BLOCK_PROCESSING_MODE,
    'block-finality'
  )
}

const foreignBlockPollingLimit = intParam(
  'ORACLE_FOREIGN_RPC_BLOCK_POLLING_LIMIT',
  ORACLE_FOREIGN_RPC_BLOCK_POLLING_LIMIT,
  { def: DEFAULT_BLOCK_POLLING_LIMIT, min: 50, max: 100000 }
)

const foreignContract = new web3Foreign.eth.Contract(foreignAbi, COMMON_FOREIGN_BRIDGE_ADDRESS)
const foreignConfig = {
  chain: 'foreign',
  bridgeAddress: COMMON_FOREIGN_BRIDGE_ADDRESS,
  bridgeABI: foreignAbi,
  pollingInterval: foreignPollingInterval,
  syncCheckInterval: intParam(
    'ORACLE_FOREIGN_RPC_SYNC_STATE_CHECK_INTERVAL',
    ORACLE_FOREIGN_RPC_SYNC_STATE_CHECK_INTERVAL,
    {
      def: DEFAULT_SYNC_STATE_CHECK_INTERVAL,
      min: MIN_SYNC_STATE_CHECK_INTERVAL,
      max: 600000,
      allow: [0] // 0 disables the sync state checker
    }
  ),
  startBlock: startBlockParam('ORACLE_FOREIGN_START_BLOCK', ORACLE_FOREIGN_START_BLOCK),
  blockPollingLimit: foreignBlockPollingLimit,
  web3: web3Foreign,
  web3Redundant: web3ForeignRedundant,
  web3Fallback: web3ForeignFallback,
  web3Archive: web3ForeignArchive || web3Foreign,
  bridgeContract: foreignContract,
  eventContract: foreignContract,
  reprocessingOptions: reprocessingOptions('FOREIGN', {
    enabled: ORACLE_FOREIGN_EVENTS_REPROCESSING === 'true',
    batchSizeRaw: ORACLE_FOREIGN_EVENTS_REPROCESSING_BATCH_SIZE,
    blockDelayRaw: ORACLE_FOREIGN_EVENTS_REPROCESSING_BLOCK_DELAY,
    defaultBatchSize: 500,
    defaultBlockDelay: 250,
    blockPollingLimit: foreignBlockPollingLimit
  }),
  beaconChainUrl: ORACLE_FOREIGN_BEACON_URL
    ? ORACLE_FOREIGN_BEACON_URL.split(',')
        .map(url => url.trim())
        .filter(url => url)
    : [],
  blockProcessingMode: blockProcessingModeParam(
    'ORACLE_FOREIGN_BLOCK_PROCESSING_MODE',
    ORACLE_FOREIGN_BLOCK_PROCESSING_MODE,
    'fcr'
  )
}

// maxProcessingTime is derived, not guessed. The old default (4x the polling interval) had nothing
// to do with how long a cycle can legitimately take: what bounds a cycle is the RPC budget, which
// is a function of the url count, the request timeout and RETRY_CONFIG. With the previous
// settings the watchdog was ~100x smaller than a single RPC call's own budget, so the process was
// killed during ordinary retries - and since a restart reloads the same lastProcessedBlock, it
// just crash-looped. Deriving this from the real url count keeps the two in step when urls are
// added, and an operator can raise it but never silently lower it below what the RPC can need.
const requiredMaxProcessingTime = Math.ceil(
  WATCHDOG_HEADROOM *
    Math.max(
      rpcCallBudget(homeUrls.length, homeOptions.requestTimeout),
      rpcCallBudget(foreignUrls.length, foreignOptions.requestTimeout)
    )
)

let maxProcessingTime = intParam('ORACLE_MAX_PROCESSING_TIME', ORACLE_MAX_PROCESSING_TIME, {
  def: requiredMaxProcessingTime,
  min: 1000,
  allow: [0] // 0 disables the watchdog entirely, as documented
})

if (maxProcessingTime !== 0 && maxProcessingTime < requiredMaxProcessingTime) {
  noteParam(
    'ORACLE_MAX_PROCESSING_TIME',
    requiredMaxProcessingTime,
    `${maxProcessingTime}ms is below the worst-case RPC budget of ${requiredMaxProcessingTime}ms ` +
      `(${homeUrls.length} home / ${foreignUrls.length} foreign urls, ${homeOptions.requestTimeout}ms timeout, ` +
      `${WATCHDOG_HEADROOM}x headroom) - raised, otherwise the watchdog kills the process during normal RPC retries`
  )
  maxProcessingTime = requiredMaxProcessingTime
}

let validatorPrivateKey
if (ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY) {
  validatorPrivateKey = add0xPrefix(ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY)
  const derived = privateKeyToAddress(validatorPrivateKey)
  if (ORACLE_VALIDATOR_ADDRESS && derived.toLowerCase() !== ORACLE_VALIDATOR_ADDRESS.toLowerCase()) {
    console.error(
      `Derived address from private key - ${derived} is different from ORACLE_VALIDATOR_ADDRESS=${ORACLE_VALIDATOR_ADDRESS}`
    )
    process.exit(EXIT_CODES.INCOMPATIBILITY)
  }
}

logResolvedConfig()

module.exports = {
  eventFilter: {},
  validatorPrivateKey,
  validatorAddress: ORACLE_VALIDATOR_ADDRESS || privateKeyToAddress(validatorPrivateKey),
  maxProcessingTime,
  shutdownKey: 'oracle-shutdown',
  home: homeConfig,
  foreign: foreignConfig,
  id
}

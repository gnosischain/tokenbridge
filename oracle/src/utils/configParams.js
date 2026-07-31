require('../../env')

const { RETRY_CONFIG, DEFAULT_POLLING_INTERVAL, DEFAULT_RPC_REQUEST_TIMEOUT } = require('./constants')

const {
  ORACLE_HOME_RPC_POLLING_INTERVAL,
  ORACLE_FOREIGN_RPC_POLLING_INTERVAL,
  ORACLE_RPC_REQUEST_TIMEOUT
} = process.env

// Every parameter resolved through intParam lands here so that startup can print the values the
// process is actually running with, together with anything that had to be overridden. Config is
// resolved before the logger is injected, so this layer writes to console.
const resolvedParams = []

function noteParam(name, value, adjustment) {
  // A parameter can be recorded twice: once when parsed, again when a cross-parameter check
  // overrides it. The later value is the effective one, so replace rather than append.
  const existing = resolvedParams.findIndex(p => p.name === name)
  const entry = { name, value, adjustment: adjustment || (existing >= 0 && resolvedParams[existing].adjustment) }
  if (existing >= 0) {
    resolvedParams[existing] = entry
  } else {
    resolvedParams.push(entry)
  }
  if (adjustment) {
    console.warn(`[config] ${name}: ${adjustment}`)
  }
}

// parseInt is too permissive for configuration. parseInt('1e5') is 1 and parseInt('4000abc') is
// 4000, so a typo silently becomes a working-but-wrong deployment. Number() rejects both.
// `|| default` is no substitute for a range check either: it only catches NaN and 0, so negative
// and absurd values pass straight through (a negative block polling limit inverts the eth_getLogs
// range and fails every single cycle).
function intParam(name, raw, { def, min = 1, max = Number.MAX_SAFE_INTEGER, allow = [] }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    noteParam(name, def)
    return def
  }

  const value = Number(String(raw).trim())

  if (!Number.isInteger(value)) {
    noteParam(name, def, `'${raw}' is not an integer - using default ${def}`)
    return def
  }
  if (!allow.includes(value) && (value < min || value > max)) {
    noteParam(name, def, `${value} is outside [${min}, ${max}] - using default ${def}`)
    return def
  }

  noteParam(name, value)
  return value
}

// Worst-case delay node-retry inserts between attempts. It computes each delay as
// min(minTimeout * factor^i, maxTimeout), then multiplies by a random value in [1, 2) when
// randomize is set - so the upper bound is twice the deterministic series.
function backoffBudget({ retries, factor, minTimeout = 1000, maxTimeout = Infinity, randomize }) {
  let total = 0
  for (let i = 0; i < retries; i++) {
    total += Math.min(minTimeout * factor ** i, maxTimeout)
  }
  return total * (randomize ? 2 : 1)
}

// Worst-case wall-clock time of ONE RPC call as HttpListProvider performs it. trySend fans out
// across every URL before promiseRetry counts a single retry, and each URL in that fan-out can
// burn a full requestTimeout - so the fetch time is (retries + 1) * urls * requestTimeout, not
// retries * requestTimeout. maxProcessingTime has to be larger than this or the watchdog kills
// the process during ordinary RPC retries rather than when something is genuinely stuck.
function rpcCallBudget(urlCount, requestTimeout) {
  return (RETRY_CONFIG.retries + 1) * urlCount * requestTimeout + backoffBudget(RETRY_CONFIG)
}

let dumpScheduled = false

// Deferred to the next tick so that every config module - base.config plus whichever
// entry-point config extends it - has finished resolving before anything is printed. Module
// loading is synchronous, so by the time this runs the parameter set is complete.
function logResolvedConfig() {
  if (process.env.NODE_ENV === 'test' || dumpScheduled) {
    return
  }
  dumpScheduled = true

  process.nextTick(() => {
    const adjusted = resolvedParams.filter(p => p.adjustment)
    console.info(
      '[config] resolved parameters:\n' +
        resolvedParams.map(p => `  ${p.name} = ${p.value}${p.adjustment ? '  (adjusted)' : ''}`).join('\n')
    )
    if (adjusted.length > 0) {
      console.warn(`[config] ${adjusted.length} parameter(s) were overridden - see the warnings above`)
    }
  })
}

// Polling intervals and the RPC request timeout are needed both by the provider layer
// (services/web3) and by the watcher config, so they are resolved once here to keep the two in
// agreement and to avoid parsing - and warning about - the same variable twice.
const homePollingInterval = intParam('ORACLE_HOME_RPC_POLLING_INTERVAL', ORACLE_HOME_RPC_POLLING_INTERVAL, {
  def: DEFAULT_POLLING_INTERVAL,
  min: 1000,
  max: 60000
})

const foreignPollingInterval = intParam('ORACLE_FOREIGN_RPC_POLLING_INTERVAL', ORACLE_FOREIGN_RPC_POLLING_INTERVAL, {
  def: DEFAULT_POLLING_INTERVAL,
  min: 1000,
  max: 60000
})

// Deliberately a flat default rather than the old `pollingInterval * 2`: the socket timeout has to
// cover the cost of the heaviest call (eth_getLogs over blockPollingLimit blocks), which has
// nothing to do with how often the loop ticks. The old derivation gave the foreign chain a 2s
// timeout, far too short for a 4000-block getLogs, which turned normal queries into retry storms.
const rpcRequestTimeout = intParam('ORACLE_RPC_REQUEST_TIMEOUT', ORACLE_RPC_REQUEST_TIMEOUT, {
  def: DEFAULT_RPC_REQUEST_TIMEOUT,
  min: 1000,
  max: 60000
})

module.exports = {
  intParam,
  noteParam,
  backoffBudget,
  rpcCallBudget,
  logResolvedConfig,
  resolvedParams,
  homePollingInterval,
  foreignPollingInterval,
  rpcRequestTimeout
}

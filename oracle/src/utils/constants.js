module.exports = {
  EXTRA_GAS_PERCENTAGE: 4,
  EXTRA_GAS_ABSOLUTE: 250000,
  AMB_AFFIRMATION_REQUEST_EXTRA_GAS_ESTIMATOR: len => Math.floor(0.0035 * len ** 2 + 40 * len),
  MIN_AMB_HEADER_LENGTH: 32 + 20 + 20 + 4 + 2 + 1 + 2,
  MAX_GAS_LIMIT: 10000000,
  // Fixed gas limits used in place of an eth_estimateGas call. Derived from observed on-chain
  // `gas_used` on the Gnosis home bridges, sampled 2026-07-31:
  //   erc-to-native 0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6 (750 txs / 8 days)
  //     executeAffirmation  p50 103,610  max   209,989
  //     submitSignature     p50 182,689  max   306,001
  //   AMB           0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59 (600 txs / 1.5 days)
  //     executeAffirmation  p50  98,018  max 1,132,985  <- tail is the caller-specified msgGasLimit
  //     submitSignature     p50 181,872  max   420,265
  // Each value is ~2.4x the observed max and is used as the FINAL gas limit: the watchers pass an
  // explicit numeric `extraGas` so sender.js takes the exact-sum branch and does NOT apply the
  // EXTRA_GAS_PERCENTAGE multiplier (note that multiplier is 1 + 4 = 5x, not 4%).
  HARDCODED_GAS_LIMIT: {
    AFFIRMATION_REQUEST: 500000,
    SIGNATURE_REQUEST: 750000,
    AMB_SIGNATURE_REQUEST: 1000000,
    // AMB affirmations additionally pay the gas limit the message itself carries, so this covers
    // only the bridge-side overhead; the watcher adds msgGasLimit + the message-length term.
    AMB_AFFIRMATION_REQUEST_BASE: 400000
  },
  MAX_CONCURRENT_EVENTS: 50,
  MAX_HISTORY_BLOCK_TO_REPROCESS: 10000,
  MAX_CONSECUTIVE_FAILURES: 10,
  SAFE_BLOCK_PROBE_RETRIES: 10,
  SAFE_BLOCK_PROBE_DELAY_MS: 5000,
  SAFE_BLOCK_MAX_GAP: 32,
  // Kept deliberately small. The poll loop is the real retry mechanism: lastProcessedBlock only
  // advances on success and runMain re-schedules unconditionally, so a failed cycle re-requests
  // the identical range on the next tick, forever. In-call retry only needs to cover a dropped
  // packet. The previous {retries: 20, factor: 1.4, maxTimeout: 360000} produced a 30-60 minute
  // backoff budget behind a 20s watchdog, so the process was always killed during the first
  // fan-out and the retries were unreachable.
  // Worst-case backoff here: (500 + 1000) * 2 = 3000ms.
  RETRY_CONFIG: {
    retries: 2,
    factor: 2,
    minTimeout: 500,
    maxTimeout: 4000,
    randomize: true
  },
  DEFAULT_POLLING_INTERVAL: 5000,
  DEFAULT_RPC_REQUEST_TIMEOUT: 10000,
  DEFAULT_BLOCK_POLLING_LIMIT: 4000,
  DEFAULT_SYNC_STATE_CHECK_INTERVAL: 60000,
  // Below roughly twice the block time the sync checker keeps seeing "no new block" and flaps
  // between RPC urls on every check.
  MIN_SYNC_STATE_CHECK_INTERVAL: 15000,
  // maxProcessingTime must exceed the worst-case RPC budget by this factor. A cycle makes several
  // sequential RPC calls, so equality would still leave the watchdog firing on ordinary slowness.
  WATCHDOG_HEADROOM: 3,
  DEFAULT_UPDATE_INTERVAL: 600000,
  DEFAULT_GAS_PRICE_FACTOR: 1,
  EXIT_CODES: {
    GENERAL_ERROR: 1,
    WATCHER_NOT_REQUIRED: 0,
    INCOMPATIBILITY: 10,
    MAX_TIME_REACHED: 11
  },
  GAS_PRICE_BOUNDARIES: {
    MIN: 1,
    MAX: 1000
  },
  MIN_GAS_PRICE_BUMP_FACTOR: 0.1,
  DEFAULT_TRANSACTION_RESEND_INTERVAL: 20 * 60 * 1000,
  FALLBACK_RPC_URL_SWITCH_TIMEOUT: 60 * 60 * 1000,
  SENDER_QUEUE_MAX_PRIORITY: 10,
  SENDER_QUEUE_SEND_PRIORITY: 5,
  SENDER_QUEUE_CHECK_STATUS_PRIORITY: 1,
  ASYNC_CALL_ERRORS: {
    // requested transaction/block/receipt does not exist
    // keccak256(NOT_FOUND)
    NOT_FOUND: '0x7bafae6429a8b3ef0db181af7c5834a6f2b1af33146a1a9ae02e833d27f2431b',
    // requested custom block does not exist yet or its timestamp is greater than the home block timestamp
    // keccak256(BLOCK_IS_IN_THE_FUTURE)
    BLOCK_IS_IN_THE_FUTURE: '0x0df7256838069bd10086ae11040abd6778b2f4e5afd247cd1442352c11c49d63',
    // eth_call has reverted or finished with OOG error
    // keccak256(REVERT)
    REVERT: 'e13872d662304a4be4efe6d4425b00781f90609ddf2ef6e5b5e5c8bc7f5ed47f',
    // evaluated output length exceeds allowed length of 64 KB
    // keccak256(RESULT_IS_TOO_LONG)
    RESULT_IS_TOO_LONG: '0x8e2ceb0f95a927556fde88310291fd5ada8156512a6dcb0cfb902c01939d3c01',
    // incorrect format of data to be decoded in request processing
    // keccak256(INPUT_DATA_HAVE_INCORRECT_FORMAT)
    INPUT_DATA_HAVE_INCORRECT_FORMAT: '0x8a93ece638d538b80a40bbcb6aae37b7537187c25360bd4b921762c59c165005',
    // Unknown error when processing the async request
    // keccak256(UNKNOWN_ERROR)
    UNKNOWN_ERROR: '0x1025faf2318c4777ee95a1387b6e521fccc5fd2cb493f8ba3c1bc85d5fee0539',
    // fail the fetch storage using getStorageAt
    // keccak256(FAIL_TO_GET_STORAGE)
    FAIL_TO_GET_STORAGE: '0x12d1c19a1ff9a4e68a7260d3ee57e12407ab9293dddf192c7e54309b85e4841f',
    // fail the fetch transaction count using getTransactionCount
    // keccak256(FAIL_TO_GET_TX_COUNT)
    FAIL_TO_GET_TX_COUNT: '0x84d7a74d7049c0a2c1a15404623fe9a4d174e705371e6822dbf40614497e0c6b'
  },
  MAX_ASYNC_CALL_RESULT_LENGTH: 64 * 1024,
  ASYNC_ETH_CALL_MAX_GAS_LIMIT: 100000000,
  DAI_ADDRESS: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  USDS_ADDRESS: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000'
}

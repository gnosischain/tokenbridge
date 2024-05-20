module.exports = {
  EXTRA_GAS_PERCENTAGE: 4,
  EXTRA_GAS_ABSOLUTE: 250000,
  AMB_AFFIRMATION_REQUEST_EXTRA_GAS_ESTIMATOR: len => Math.floor(0.0035 * len ** 2 + 40 * len),
  MIN_AMB_HEADER_LENGTH: 32 + 20 + 20 + 4 + 2 + 1 + 2,
  MAX_GAS_LIMIT: 10000000,
  MAX_CONCURRENT_EVENTS: 50,
  MAX_HISTORY_BLOCK_TO_REPROCESS: 10000,
  RETRY_CONFIG: {
    retries: 20,
    factor: 1.4,
    maxTimeout: 360000,
    randomize: true
  },
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
  ASYNC_ETH_CALL_MAX_GAS_LIMIT: 100000000
}

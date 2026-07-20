const baseConfig = require('./base.config')

// Single validator process for the whole oracle. It reads baseConfig.home / baseConfig.foreign
// and validates whichever side(s) run in FCR mode (blockProcessingMode === 'fcr').
// Pending records are keyed by chain (home/foreign) in redis.
const id = 'fcr-txs-validator'

module.exports = {
  ...baseConfig,
  id,
  name: id,
}

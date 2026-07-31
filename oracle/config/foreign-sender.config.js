const baseConfig = require('./base.config')

const { DEFAULT_TRANSACTION_RESEND_INTERVAL } = require('../src/utils/constants')
const { intParam } = require('../src/utils/configParams')

const { ORACLE_FOREIGN_TX_RESEND_INTERVAL } = process.env

module.exports = {
  ...baseConfig,
  main: baseConfig.foreign,
  queue: 'foreign-prioritized',
  id: 'foreign',
  name: 'sender-foreign',
  resendInterval: intParam('ORACLE_FOREIGN_TX_RESEND_INTERVAL', ORACLE_FOREIGN_TX_RESEND_INTERVAL, {
    def: DEFAULT_TRANSACTION_RESEND_INTERVAL,
    min: 1000
  })
}

const baseConfig = require('./base.config')

const { DEFAULT_TRANSACTION_RESEND_INTERVAL } = require('../src/utils/constants')
const { intParam } = require('../src/utils/configParams')

const { ORACLE_HOME_TX_RESEND_INTERVAL } = process.env

module.exports = {
  ...baseConfig,
  main: baseConfig.home,
  queue: 'home-prioritized',
  id: 'home',
  name: 'sender-home',
  resendInterval: intParam('ORACLE_HOME_TX_RESEND_INTERVAL', ORACLE_HOME_TX_RESEND_INTERVAL, {
    def: DEFAULT_TRANSACTION_RESEND_INTERVAL,
    min: 1000
  })
}

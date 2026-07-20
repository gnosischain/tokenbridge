process.env.NODE_ENV = 'test'

const sinon = require('sinon')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
const proxyquire = require('proxyquire')

chai.use(chaiAsPromised)
chai.should()
const { expect } = chai

// A chainable redis pipeline stub. All mutating calls return the same object so
// `.zrem(...).del(...).exec()` works; exec resolves. One object per redis stub so we
// can assert which pipeline commands were issued across all pipeline() calls.
function makePipeline() {
  const p = {}
  p.zrem = sinon.stub().returns(p)
  p.del = sinon.stub().returns(p)
  p.rpush = sinon.stub().returns(p)
  p.exec = sinon.stub().resolves([])
  return p
}

// Build the module under test with injected stubs. `config` sets which sides are fcr.
function loadChecker({ config, redisStub, loggerStub, getBlockNumberStub }) {
  process.argv[2] = 'fcr-txs-validator.config.js'
  return proxyquire('../src/fcrTxsChecker', {
    '../env': {},
    './services/redisClient': { redis: redisStub },
    './services/logger': loggerStub,
    './tx/web3': { getBlockNumber: getBlockNumberStub },
    './utils/utils': { checkHTTPS: () => () => () => {}, watchdog: async fn => fn() },
    // path.join('../config/', 'fcr-txs-validator.config.js') === this key
    '../config/fcr-txs-validator.config.js': config
  })
}

const homeFcrConfig = {
  id: 'fcr-txs-validator',
  home: { chain: 'home', blockProcessingMode: 'fcr', pollingInterval: 1000, web3: {} },
  foreign: { chain: 'foreign', blockProcessingMode: 'block-finality', pollingInterval: 1000, web3: {} }
}

describe('fcrTxsChecker', () => {
  let redisStub
  let loggerStub
  let getBlockNumberStub
  let pipeline

  beforeEach(() => {
    pipeline = makePipeline()
    redisStub = {
      status: 'ready',
      pipeline: sinon.stub().returns(pipeline),
      zcard: sinon.stub().resolves(0),
      zrangebyscore: sinon.stub().resolves([]),
      smembers: sinon.stub().resolves([])
    }
    loggerStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
      fatal: sinon.stub()
    }
    getBlockNumberStub = sinon.stub()
  })

  afterEach(() => {
    sinon.restore()
  })

  // A side whose web3.eth.getBlock we control per test.
  function makeSide(chain = 'home') {
    return { chain, web3: { eth: { getBlock: sinon.stub() } } }
  }

  describe('fcrSides selection (derived from block processing mode)', () => {
    it('selects only the chains in fcr mode', () => {
      const checker = loadChecker({
        config: {
          id: 'fcr-txs-validator',
          home: { chain: 'home', blockProcessingMode: 'fcr', pollingInterval: 1000, web3: {} },
          foreign: { chain: 'foreign', blockProcessingMode: 'fcr', pollingInterval: 500, web3: {} }
        },
        redisStub,
        loggerStub,
        getBlockNumberStub
      })
      expect(checker.fcrSides.map(s => s.chain)).to.deep.equal(['home', 'foreign'])
    })

    it('selects a single side when only one is fcr', () => {
      const checker = loadChecker({ config: homeFcrConfig, redisStub, loggerStub, getBlockNumberStub })
      expect(checker.fcrSides.map(s => s.chain)).to.deep.equal(['home'])
    })

    it('selects no side when neither is fcr', () => {
      const checker = loadChecker({
        config: {
          id: 'fcr-txs-validator',
          home: { chain: 'home', blockProcessingMode: 'block-finality', pollingInterval: 1000, web3: {} },
          foreign: { chain: 'foreign', blockProcessingMode: 'block-finality', pollingInterval: 1000, web3: {} }
        },
        redisStub,
        loggerStub,
        getBlockNumberStub
      })
      expect(checker.fcrSides).to.have.length(0)
    })
  })

  describe('validateChain', () => {
    let checker
    let side

    beforeEach(() => {
      checker = loadChecker({ config: homeFcrConfig, redisStub, loggerStub, getBlockNumberStub })
      side = makeSide('home')
    })

    it('Case 1: skips when finalized block is unavailable', async () => {
      getBlockNumberStub.resolves(0)

      await checker.validateChain(side)

      expect(redisStub.zrangebyscore.called).to.be.false
      expect(side.web3.eth.getBlock.called).to.be.false
      expect(pipeline.zrem.called).to.be.false
    })

    it('Case 2: does nothing when no blocks are due (<= finalized)', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves([])

      await checker.validateChain(side)

      expect(side.web3.eth.getBlock.called).to.be.false
      expect(pipeline.zrem.called).to.be.false
      expect(pipeline.rpush.called).to.be.false
    })

    it('Case 3: prunes a block whose stored hash matches the canonical finalized hash', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xB997', '997'])
      side.web3.eth.getBlock.resolves({ hash: '0xB997' })

      await checker.validateChain(side)

      expect(side.web3.eth.getBlock.calledOnceWith(997)).to.be.true
      expect(pipeline.zrem.calledWith('home:pendingSafeBlocks', '0xB997')).to.be.true
      expect(pipeline.del.calledWith('home:pendingSafeTxs:0xB997')).to.be.true
      expect(pipeline.rpush.called).to.be.false
      expect(loggerStub.error.called).to.be.false
    })

    it('Case 4: records a false positive when the stored hash no longer matches', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xB999', '999'])
      redisStub.smembers.resolves(['0xccc-0'])
      side.web3.eth.getBlock.resolves({ hash: '0xC999' })

      await checker.validateChain(side)

      // one FP record pushed, tagged with chain + canonical hash
      expect(pipeline.rpush.calledOnce).to.be.true
      const [key, payload] = pipeline.rpush.firstCall.args
      expect(key).to.equal('home:safeTxFalsePositives')
      expect(JSON.parse(payload)).to.deep.include({
        chain: 'home',
        txHash: '0xccc',
        logIndex: '0',
        blockNumber: 999,
        storedBlockHash: '0xB999',
        canonicalBlockHash: '0xC999',
        detectedAt: 1005
      })
      expect(loggerStub.error.calledOnce).to.be.true
      // and still pruned afterwards
      expect(pipeline.zrem.calledWith('home:pendingSafeBlocks', '0xB999')).to.be.true
    })

    it('attribution: one FP record per event in the reorged block, parsing txHash-logIndex', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xB997', '997'])
      redisStub.smembers.resolves(['0xaaa-0', '0xbbb-2'])
      side.web3.eth.getBlock.resolves({ hash: '0xDEAD' })

      await checker.validateChain(side)

      expect(pipeline.rpush.calledTwice).to.be.true
      const second = JSON.parse(pipeline.rpush.secondCall.args[1])
      expect(second).to.deep.include({ txHash: '0xbbb', logIndex: '2' })
    })

    it('Case 5: competing forks at one height — one getBlock, loser flagged, winner pruned', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xB999', '999', '0xC999', '999'])
      redisStub.smembers.resolves(['0xccc-0'])
      side.web3.eth.getBlock.resolves({ hash: '0xC999' })

      await checker.validateChain(side)

      // only one RPC despite two members at the same height
      expect(side.web3.eth.getBlock.calledOnce).to.be.true
      // loser (0xB999) recorded as FP; winner (0xC999) not
      expect(pipeline.rpush.calledOnce).to.be.true
      expect(pipeline.zrem.calledWith('home:pendingSafeBlocks', '0xB999')).to.be.true
      expect(pipeline.zrem.calledWith('home:pendingSafeBlocks', '0xC999')).to.be.true
    })

    it('Case 6: does NOT prune when the canonical block cannot be fetched (null)', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xB997', '997'])
      side.web3.eth.getBlock.resolves(null)

      await checker.validateChain(side)

      expect(loggerStub.warn.called).to.be.true
      expect(pipeline.zrem.called).to.be.false
      expect(pipeline.del.called).to.be.false
      expect(pipeline.rpush.called).to.be.false
    })

    it('dedups getBlock to one call per distinct block number', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zrangebyscore.resolves(['0xA', '997', '0xB', '999'])
      side.web3.eth.getBlock.withArgs(997).resolves({ hash: '0xA' })
      side.web3.eth.getBlock.withArgs(999).resolves({ hash: '0xB' })

      await checker.validateChain(side)

      expect(side.web3.eth.getBlock.calledTwice).to.be.true
    })

    it('warns when the pending backlog exceeds the threshold', async () => {
      getBlockNumberStub.resolves(1005)
      redisStub.zcard.resolves(checker.PENDING_BACKLOG_WARN_THRESHOLD + 1)
      redisStub.zrangebyscore.resolves([])

      await checker.validateChain(side)

      expect(loggerStub.warn.calledWithMatch({ chain: 'home' })).to.be.true
    })
  })

  describe('recordFalsePositive', () => {
    it('parses each event key, pushes a JSON record, and resolves the block', async () => {
      const checker = loadChecker({ config: homeFcrConfig, redisStub, loggerStub, getBlockNumberStub })
      redisStub.smembers.resolves(['0xabc-3'])

      await checker.recordFalsePositive('foreign', 42, '0xStored', '0xCanon', 100)

      expect(redisStub.smembers.calledWith('foreign:pendingSafeTxs:0xStored')).to.be.true
      const record = JSON.parse(pipeline.rpush.firstCall.args[1])
      expect(record).to.deep.equal({
        chain: 'foreign',
        txHash: '0xabc',
        logIndex: '3',
        blockNumber: 42,
        storedBlockHash: '0xStored',
        canonicalBlockHash: '0xCanon',
        detectedAt: 100
      })
      // pruned after recording
      expect(pipeline.zrem.calledWith('foreign:pendingSafeBlocks', '0xStored')).to.be.true
      expect(pipeline.del.calledWith('foreign:pendingSafeTxs:0xStored')).to.be.true
    })
  })

  describe('main', () => {
    it('validates every fcr side each cycle', async () => {
      const checker = loadChecker({
        config: {
          id: 'fcr-txs-validator',
          home: {
            chain: 'home',
            blockProcessingMode: 'fcr',
            pollingInterval: 1000,
            web3: { eth: { getBlock: sinon.stub() } }
          },
          foreign: {
            chain: 'foreign',
            blockProcessingMode: 'fcr',
            pollingInterval: 1000,
            web3: { eth: { getBlock: sinon.stub() } }
          }
        },
        redisStub,
        loggerStub,
        getBlockNumberStub
      })
      getBlockNumberStub.resolves(0) // short-circuit each side after the finalized fetch

      await checker.main()

      expect(getBlockNumberStub.calledTwice).to.be.true
    })
  })
})

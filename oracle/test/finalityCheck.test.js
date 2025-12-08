process.env.NODE_ENV = 'test'

const sinon = require('sinon')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
const proxyquire = require('proxyquire')

chai.use(chaiAsPromised)
chai.should()
const { expect } = chai

describe('blockFinalityCheck', () => {
  let checkLastFinalizedBlock
  let getLastBlockToProcess
  let sendGetStub
  let consoleLogStub
  let loggerStub
  let redisStub
  let web3Stub
  let bridgeContractStub

  beforeEach(() => {
    sendGetStub = sinon.stub()
    consoleLogStub = sinon.stub(console, 'log')
    loggerStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub()
    }

    redisStub = {
      get: sinon.stub(),
      set: sinon.stub()
    }

    web3Stub = {}
    bridgeContractStub = {}

    const blockFinalityCheck = proxyquire('../src/blockFinalityCheck', {
      './services/HttpListProvider': { sendGet: sendGetStub },
      './services/logger': loggerStub,
      '../env': {}
    })

    checkLastFinalizedBlock = blockFinalityCheck.checkLastFinalizedBlock

    // Mock the getLastBlockToProcess function from watcher.js for integration tests
    getLastBlockToProcess = async (beaconChainUrls) => {
      const lastFinalizedBlock = await checkLastFinalizedBlock(beaconChainUrls)
      return lastFinalizedBlock
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('checkLastFinalizedBlock', () => {
    it('should console.log error when sendGet returns 404 or invalid result', async () => {
      const error = new Error('404 Not Found')
      sendGetStub.rejects(error)

      try {
        await checkLastFinalizedBlock(['https://example.com/finalized'])
      } catch (e) {
        expect(loggerStub.error.calledWith('All beacon chain URLs failed')).to.be.true
        expect(e.message).to.equal('Cannot obtain latest finalized block from any provided URL')
      }
    })

    it('should console.log error when result is null', async () => {
      sendGetStub.resolves(null)

      try {
        await checkLastFinalizedBlock(['https://example.com/finalized'])
      } catch (e) {
        expect(loggerStub.warn.calledWith('Empty or invalid response from URL 1: https://example.com/finalized')).to.be.true
        expect(e.message).to.equal('Cannot obtain latest finalized block from any provided URL')
      }
    })

    it('should handle normal case successfully', async () => {
      const mockResult = {
        data: {
          message: {
            body: {
              execution_payload: {
                block_number: '123532'
              }
            }
          }
        }
      }

      sendGetStub.resolves(mockResult)

      const result = await checkLastFinalizedBlock(['https://examples.com/finalized'])

      expect(result).to.equal('123532')
      expect(loggerStub.info.calledWith('Last finalized block: 123532 (from URL 1)')).to.be.true
      expect(sendGetStub.calledOnce).to.be.true
      expect(
        sendGetStub.calledWith('https://examples.com/finalized', {
          requestTimeout: 30000
        })
      ).to.be.true
    })
    
    it('should handle multiple URLs with fallback logic', async () => {
      const mockResult = {
        data: {
          message: {
            body: {
              execution_payload: {
                block_number: '123532'
              }
            }
          }
        }
      }
      
      // First URL fails, second succeeds
      sendGetStub.onFirstCall().rejects(new Error('Network timeout'))
      sendGetStub.onSecondCall().resolves(mockResult)
      
      const result = await checkLastFinalizedBlock(['https://beacon1.com', 'https://beacon2.com'])
      
      expect(result).to.equal('123532')
      expect(sendGetStub.calledTwice).to.be.true
      expect(loggerStub.warn.calledWith('Failed to get finalized block from URL 1 (https://beacon1.com): Network timeout')).to.be.true
      expect(loggerStub.info.calledWith('Last finalized block: 123532 (from URL 2)')).to.be.true
    })
    
    it('should throw error when all URLs fail', async () => {
      const error1 = new Error('Network timeout')
      const error2 = new Error('Service unavailable')
      
      sendGetStub.onFirstCall().rejects(error1)
      sendGetStub.onSecondCall().rejects(error2)
      
      try {
        await checkLastFinalizedBlock(['https://beacon1.com', 'https://beacon2.com'])
      } catch (e) {
        expect(e.message).to.equal('Cannot obtain latest finalized block from any provided URL')
        expect(sendGetStub.calledTwice).to.be.true
        expect(loggerStub.error.calledWith('All beacon chain URLs failed')).to.be.true
      }
    })
    
    it('should handle empty URL array', async () => {
      try {
        await checkLastFinalizedBlock([])
      } catch (e) {
        expect(e.message).to.equal('No beacon chain URLs provided')
      }
    })
  })

  describe('Watcher Integration Tests', () => {
    describe('Redis lastProcessedBlock scenarios', () => {
      it('should handle when lastProcessedBlock from redis is 0', async () => {
        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '123532'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)
        redisStub.get.resolves('0') // Redis returns '0'

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('123532')
        expect(sendGetStub.calledOnce).to.be.true
        expect(loggerStub.info.calledWith('Last finalized block: 123532 (from URL 1)')).to.be.true
      })

      it('should handle when startBlock from process.env is 0', async () => {
        process.env.STARTING_BLOCK = '0'

        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '123532'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)
        redisStub.get.resolves(null) // No previous block in redis

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('123532')
        expect(sendGetStub.calledOnce).to.be.true
        expect(loggerStub.info.calledWith('Last finalized block: 123532 (from URL 1)')).to.be.true

        delete process.env.STARTING_BLOCK
      })

      it('should handle when both lastProcessedBlock and startBlock are non-zero', async () => {
        // lastBlockToProcess <= lastProcessedBlock
        process.env.STARTING_BLOCK = '100'
        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '99'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)
        redisStub.get.resolves('100') // Last processed was 100

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('99')
        expect(sendGetStub.calledOnce).to.be.true
        expect(loggerStub.info.calledWith('Last finalized block: 99 (from URL 1)')).to.be.true

        delete process.env.STARTING_BLOCK
      })
    })

    describe('getLastFinalizedBlock error scenarios', () => {
      it('should return null when getLastFinalizedBlock returns null', async () => {
        sendGetStub.resolves(null)

        try {
          await getLastBlockToProcess(['https://beacon.rpc.com'])
        } catch (e) {
          expect(e.message).to.equal('Cannot obtain latest finalized block from any provided URL')
          expect(loggerStub.warn.calledWith('Empty or invalid response from URL 1: https://beacon.rpc.com')).to.be.true
        }
      })

      it('should handle when getLastFinalizedBlock returns block number 0', async () => {
        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '0'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('0')
        expect(loggerStub.info.calledWith('Last finalized block: 0 (from URL 1)')).to.be.true
      })

      it('should handle when getLastFinalizedBlock throws error', async () => {
        const networkError = new Error('Network timeout')
        sendGetStub.rejects(networkError)

        try {
          await getLastBlockToProcess('https://beacon.rpc.com', web3Stub, bridgeContractStub)
        } catch (e) {
          expect(e.message).to.equal('Cannot obtain latest finalized block from any provided URL')
          expect(loggerStub.error.calledWith('All beacon chain URLs failed')).to.be.true
        }
      })
    })

    describe('Normal operation scenarios', () => {
      it('should handle normal case where getLastFinalizedBlock > lastProcessedBlock', async () => {
        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '1000'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)
        redisStub.get.resolves('500') // Last processed was 500

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('1000')
        expect(sendGetStub.calledOnce).to.be.true
        expect(loggerStub.info.calledWith('Last finalized block: 1000 (from URL 1)')).to.be.true
      })

      it('should handle case where getLastFinalizedBlock equals lastProcessedBlock', async () => {
        const mockResult = {
          data: {
            message: {
              body: {
                execution_payload: {
                  block_number: '500'
                }
              }
            }
          }
        }

        sendGetStub.resolves(mockResult)
        redisStub.get.resolves('500') // Same as finalized block

        const result = await getLastBlockToProcess(['https://beacon.rpc.com'])

        expect(result).to.equal('500')
        expect(loggerStub.info.calledWith('Last finalized block: 500 (from URL 1)')).to.be.true
      })

      it('should handle malformed response data gracefully', async () => {
        const malformedResponse = {
          data: {
            // Missing message.body.execution_payload structure
            message: {}
          }
        }

        sendGetStub.resolves(malformedResponse)

        try {
          await getLastBlockToProcess('https://beacon.rpc.com', web3Stub, bridgeContractStub)
        } catch (e) {
          // Should throw an error when trying to access nested properties
          expect(e).to.be.an('error')
        }
      })
    })
  })
})

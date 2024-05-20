const { toBN } = require('web3').utils

const { ASYNC_CALL_ERRORS } = require('../../../utils/constants')

async function call(web3, data, foreignBlock) {
  let address, slot
  let value
  try{
  const decoded = web3.eth.abi.decodeParameters(['address', 'bytes32'], data)
  address = decoded[0]
  slot = decoded[1]
  }catch{
    return [false, ASYNC_CALL_ERRORS.INPUT_DATA_HAVE_INCORRECT_FORMAT]
  }

  try{
    value = await web3.eth.getStorageAt(address, slot, foreignBlock.number)
  }catch{
    return [false,ASYNC_CALL_ERRORS.FAIL_TO_GET_STORAGE]
  }

  return [true, web3.eth.abi.encodeParameter('bytes32', value)]
}

async function callArchive(web3, data, foreignBlock) {
  let address, slot, blockNumber
  let value
  try{
    const decoded = web3.eth.abi.decodeParameters(['address', 'bytes32', 'uint256'], data)
    address = decoded[0]
    slot = decoded[1]
    blockNumber = decoded[2]
  }catch{
    return [false, ASYNC_CALL_ERRORS.INPUT_DATA_HAVE_INCORRECT_FORMAT]
  }

  if (toBN(blockNumber).gt(toBN(foreignBlock.number))) {
    return [false, ASYNC_CALL_ERRORS.BLOCK_IS_IN_THE_FUTURE]
  }

  try{
    value = await web3.eth.getStorageAt(address, slot, blockNumber)
  }catch{
    return [false,ASYNC_CALL_ERRORS.FAIL_TO_GET_STORAGE]
  }
  
  return [true, web3.eth.abi.encodeParameter('bytes32', value)]
}

module.exports = {
  'eth_getStorageAt(address,bytes32)': call,
  'eth_getStorageAt(address,bytes32,uint256)': callArchive
}

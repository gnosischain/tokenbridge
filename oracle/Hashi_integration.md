# Hashi integration

[Hashi](https://github.com/gnosis/hashi) integration in Gnosis tokenbridge introduces a few changes(more in below) in the contracts level. To make the Oracle code compatible to the integration, here are the steps to compile and run the code.

1. Clone the repo: `git clone https://github.com/gnosischain/tokenbridge.git`
2. Update gitmdoule: `git submodule init && git submodule update`
3. Switch to the `feat/hashi-integration-xdai-bridge` branch: `cd contracts && git switch feat/hashi-integration-xdai-bridge & cd ..`
4. Install and compile contracts: `nvm use && yarn initialize`
5. Update .env file: `.env.xdai` & `.env.amb` respectively.
6. Build and run
   1. AMB:
   ```
    env ORACLE_VALIDATOR_ADDRESS=<validator address> \
    env ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY=<validator address private key> \
    docker-compose -f docker-compose-build.yml -f docker-compose-amb.yml up -d --build
   ```
   2. xDAI:
   ```
    env ORACLE_VALIDATOR_ADDRESS=<validator address> \
    env ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY=<validator address private key> \
    docker-compose -f docker-compose-build.yml -f docker-compose-xdai.yml up -d --build
   ```

## Contracts changes from Hashi integration

1. `UserRequestForAffirmation` includes `nonce` in xDAI(Erc to Native) bridge:
   Current event `UserRequestForAffirmation(address recipient, uint256 value)` only has `recipient` and `value` as arguments ([code](<(https://github.com/gnosischain/tokenbridge-contracts/blob/master/contracts/upgradeable_contracts/BasicForeignBridge.sol#L15)>)). After hashi integration, it will become event `UserRequestForAffirmation(address recipient, uint256 value, bytes32 nonce)` ([code](https://github.com/crosschain-alliance/tokenbridge-contracts/blob/feat/hashi-integration-xdai-bridge/contracts/upgradeable_contracts/BasicForeignBridge.sol#L15))
2. Once HASHI_IS_MANDATORY is set to true, a message need to be approved by Hashi before a validator can call `executeAffirmation` on home chain, or anyone can call `executeSignatures` on foregin chain to claim/execute a message. Oracle need to check `isApprovedByHashi(bytes32 messageHash)` before executing a message. ([code](https://github.com/crosschain-alliance/tokenbridge-contracts/blob/feat/hashi-integration-amb/contracts/upgradeable_contracts/BasicBridge.sol#L32-L34))

## Reference

1. Hashi: https://crosschain-alliance.gitbook.io/hashi/v0.2/introduction
2. Gnosis Docs: https://docs.gnosischain.com/bridges

# USDS migration

1. Update .env file: `.env.xdai` & `.env.amb` respectively (refer to `.env.example.xdai` & `.env.example.amb`).
2. Build and run
   1. AMB:
   ```
    env ORACLE_VALIDATOR_ADDRESS=<validator address> \
    env ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY=<validator address private key> \
    docker-compose -f docker-compose-amb.yml up -d --build
   ```
   2. xDAI:
   ```
    env ORACLE_VALIDATOR_ADDRESS=<validator address> \
    env ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY=<validator address private key> \
    docker-compose -f docker-compose-xdai.yml up -d --build
   ```


## Contracts changes from USDS migration

1. `UserRequestForSignature` on xDAI Bridge includes `address token`: 
    >> Before
    `event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce)`
    << After
    `event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)`

# Instructions

## Prerequisite

1. In the root level, run `nvm use && yarn initialize`.
2. Run the following script with `cd oracle && yarn run helper:$scriptName $variable1 $variable2 ...`

## Script

3. executeAmbAffirmation.js:
   Script to call `executeAffirmation` on Home AMB Bridge.

   1. Get the $messageData from `UserRequestForAffirmation` event from Foreign AMB Bridge
   2. Make sure the `ORACLE_BRIDGE_MODE`, `ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY`, `COMMON_HOME_BRIDGE_ADDRESS`, `COMMON_FOREIGN_BRIDGE_ADDRESS` are set in the `.env`
   3. Run `yarn run helper:executeAmbAffirmation $messageData $privateKey(optional, if $ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY is not set)`

4. executeNativeAffirmation.js:
   Script to call `executeAffirmation` on Home xDAI Bridge.

   1. Get the `$recipient`, `$value`, `$nonce` (or `$txHash`) from `UserRequestForAffirmation` event from Foreign xDAI Bridge
   2. Make sure the `ORACLE_BRIDGE_MODE`, `ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY`, `COMMON_HOME_BRIDGE_ADDRESS`, `COMMON_FOREIGN_BRIDGE_ADDRESS` are set in the `.env`
   3. Run `yarn run helper:executeNativeAffirmation $recipient $value $nonce $privateKey(optional, if $ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY is not set)`

5. submitSignatures.js:
   Script to call `submitSignatures` on Home xDAI / AMB bridge.

   1. Get the transaction hash where `UserRequestForSignatures` is emitted from the Home bridge.
   2. Make sure the `ORACLE_BRIDGE_MODE`, `ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY`, `COMMON_HOME_BRIDGE_ADDRESS`, `COMMON_FOREIGN_BRIDGE_ADDRESS` are set in the `.env`
   3. Run `yarn run helper:submitSignatures $txHash $privateKey(optional, if $ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY is not set)`

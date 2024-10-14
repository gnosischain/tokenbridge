![tokenbridge](https://github.com/poanetwork/tokenbridge/workflows/tokenbridge/badge.svg?branch=master)
[![Gitter](https://badges.gitter.im/poanetwork/poa-bridge.svg)](https://gitter.im/poanetwork/poa-bridge?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)
[![License: LGPL v3.0](https://img.shields.io/badge/License-LGPL%20v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

# Tokenbridge

Welcome to the **Gnosis Chain TokenBridge** monorepository!

Please note that this repository as a **work in progress**.

## Overview

The Gnosis Chain TokenBridge allows users to transfer assets between Ethereum and Gnosis Chain. It is composed of several elements which are contained within this monorepository.

For a complete picture of the Gnosis Chain TokenBridge functionality, it is useful to explore each subrepository.

## Structure

Sub-repositories maintained within this monorepo are listed below.

> Only Oracle folder is actively maintained at the moment.

| Sub-repository                                         | Description                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [Oracle](oracle/README.md)                             | Responsible for listening to bridge related events and authorizing asset transfers. |
| [Monitor](monitor/README.md)                           | Tool for checking balances and unprocessed events in bridged networks.              |
| [Deployment](deployment/README.md)                     | Ansible playbooks for deploying cross-chain bridges.                                |
| [Oracle-E2E](oracle-e2e/README.md)                     | End to end tests for the Oracle                                                     |
| [Monitor-E2E](monitor-e2e/README.md)                   | End to end tests for the Monitor                                                    |
| [Deployment-E2E](deployment-e2e/README.md)             | End to end tests for the Deployment                                                 |
| [Commons](commons/README.md)                           | Interfaces, constants and utilities shared between the sub-repositories             |
| [E2E-Commons](e2e-commons/README.md)                   | Common utilities and configuration used in end to end tests                         |
| [ALM](alm/README.md)                                   | DApp interface tool for AMB Live Monitoring                                         |
| [Burner-wallet-plugin](burner-wallet-plugin/README.md) | TokenBridge Burner Wallet 2 Plugin                                                  |

Additionally there are [Smart Contracts](https://github.com/gnosischain/tokenbridge-contracts) used to manage bridge validators, collect signatures, and confirm asset relay and disposal.

## Available deployments

https://bridge.gnosischain.com/

## Network Definitions

Bridging occurs between two networks.

- **Home** - or **Native** - is a network with fast and inexpensive operations. All bridge operations to collect validator confirmations are performed on this side of the bridge; generally it refers to the Gnosis Chain.

- **Foreign** can be any chain; generally it refers to the Ethereum mainnet.

## Operational Modes

The Gnosis Chain TokenBridge provides two operational modes:

- [x] `ERC20-to-Native`: DAI token in the Ethereum are locked and xDAI are minted in the Gnosis Chain. In this mode, the Gnosis Chain consensus engine invokes [Parity's Block Reward contract](https://openethereum.github.io/Block-Reward-Contract) to mint coins per the bridge contract request.
- [x] `Arbitrary-Message`: Transfer arbitrary data between two networks as so the data could be interpreted as an arbitrary contract method invocation.

## Initializing the monorepository

Clone the repository:

```bash
git clone https://github.com/gnosischain/tokenbridge.git
```

If there is no need to build docker images for the TokenBridge components (oracle, monitor), install dependencies, compile the smart contracts:

```
yarn initialize
```

Then refer to the corresponding README files to get information about particular TokenBridge component.

> While installing dependencies, you may encounter a node-gyp error due to the use of an older Node.js version. This issue does not impact the core functionality of the project. You can proceed with compiling the smart contracts without any concerns.

## Linting

Running linter for all JS projects:

```
yarn lint
```

## Tests

Running tests for all projects:

```
yarn test
```

Additionally there are end-to-end tests for [Oracle](oracle-e2e/README.md) and [Monitor](monitor-e2e/README.md).

For details on building, running and developing please refer to respective READMEs in sub-repositories.

## Building, running and deploying

Please refer to the instructions in sub-directories.
Configuration details are available [here](./CONFIGURATION.md).

## Contributing

See the [CONTRIBUTING](CONTRIBUTING.md) document for contribution, testing and pull request protocol.

## License

This project is licensed under the GNU Lesser General Public License v3.0. See the [LICENSE](LICENSE) file for details.

## References

- https://docs.gnosischain.com/bridges

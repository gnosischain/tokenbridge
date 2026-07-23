# FCR integration

## Scope

Enable **FCR (Fast Confirmation Rule)** processing for the oracle validator (watcher).

- **Processing**: an event-watcher can run in `fcr` mode (process source events up to the
  `safe` block instead of waiting for finality) or `block-finality`
  mode (process only finalized blocks, current behavior). Mode is **per chain**
  (home/foreign, independent).
- **Revalidation**: `safe` blocks are not final and can be reorged out, so a new
  `fcrTxsChecker` worker revalidates every FCR-processed **source block** once it is
  finalized. If the stored block hash no longer matches the canonical finalized block,
  the event(s) we attested to were reorged out.
- **Alert**: false positives are logged and recorded to redis for
  Grafana; nothing is undone on-chain (bridge contracts cannot un-sign).

## New logic changes

| File                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/base.config.js`              | Read `ORACLE_HOME/FOREIGN_BLOCK_PROCESSING_MODE` into `home`/`foreign` config as `blockProcessingMode`.                                                                                                                                                                                                                                                                                                                                                             |
| `src/tx/web3.js`                     | `getBlockNumber(web3, type)` and `getBlock(web3, tag)` now support `safe` \| `finalized`. On web3 1.6.x these tags can't go through `web3.eth.*` (the input formatter rejects them and we can't upgrade — see the "Deeper root cause found during implementation" section), so a new `rawGetBlockByTag` issues a raw `eth_getBlockByNumber('<tag>', false)` through the provider's `send` (keeps `HttpListProvider` failover).                                      |
| `src/watcher.js`                     | Bind `blockProcessingMode` from `config.main` . `getLastBlockToProcess()` caps the range at `safe` (fcr) or `finalized` (block-finality). New `recordSafeTxs(events)` — in fcr mode, after `sendToQueue(job)`, record each attested source block (see Redis keys). Keyed by **chain**, so all watchers on a chain share one pending set (idempotent `ZADD` dedups).                                                                                                 |
| `src/fcrTxsChecker.js`               | Standalone worker. Validates whichever side(s) have `blockProcessingMode === 'fcr'` (derived from config — no targeting vars). Per cycle, per fcr chain: fetch `finalized` → `ZRANGEBYSCORE` pending blocks ≤ finalized → one `getBlock` per distinct block → compare stored hash to canonical. Match → prune (`ZREM` + `DEL`); mismatch → record false positive (`logger.error` + `RPUSH`) then prune; null `getBlock` → retry next cycle. Warns on large backlog. |
| `config/fcr-txs-validator.config.js` | Spreads `baseConfig` (exposes `home`/`foreign`); `id = 'fcr-txs-validator'`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `package.json`                       | New script `validator:fcr-txs` → `start-worker.sh fcrTxsChecker fcr-txs-validator`.                                                                                                                                                                                                                                                                                                                                                                                 |

### Redis keys (prefixed by `chain` = `home` / `foreign`)

| Key                                   | Type                                       | Written by | Read by                  |
| ------------------------------------- | ------------------------------------------ | ---------- | ------------------------ |
| `${chain}:pendingSafeBlocks`          | ZSET (score=blockNumber, member=blockHash) | watcher(s) | checker                  |
| `${chain}:pendingSafeTxs:<blockHash>` | SET (members=`txHash-logIndex`)            | watcher(s) | checker                  |
| `${chain}:safeTxFalsePositives`       | LIST (JSON records)                        | checker    | Grafana Redis datasource |

## New env variables

| Var                                    | Values                    | Default          | Purpose                          |
| -------------------------------------- | ------------------------- | ---------------- | -------------------------------- |
| `ORACLE_HOME_BLOCK_PROCESSING_MODE`    | `fcr` \| `block-finality` | `block-finality` | Home watcher processing mode.    |
| `ORACLE_FOREIGN_BLOCK_PROCESSING_MODE` | `fcr` \| `block-finality` | `block-finality` | Foreign watcher processing mode. |

### New constants (`src/utils/constants.js`, hardcoded — not env-overridable)

| Constant                    | Value | Purpose                                              |
| --------------------------- | ----- | ---------------------------------------------------- |
| `SAFE_BLOCK_PROBE_RETRIES`  | 10    | Max probe attempts per tag before fallback           |
| `SAFE_BLOCK_PROBE_DELAY_MS` | 5000  | Delay between probe attempts                         |
| `SAFE_BLOCK_MAX_GAP`        | 32    | Max `latest - safe` gap to consider `safe` supported |

## Monitoring

Grafana reads redis directly via the **Redis datasource plugin**:

- `ZCARD <chain>:pendingSafeBlocks` — pending backlog
- `LLEN <chain>:safeTxFalsePositives` — false-positive count (alert on `> 0`)
- `LRANGE <chain>:safeTxFalsePositives 0 -1` — false-positive detail records

## Test

### Unit Test

```bash
nvm use 12.22.12
cd oracle
NODE_ENV=test ../node_modules/.bin/mocha --exit --timeout 10000 test/fcrTxsChecker.test.js
```

## Technical decision

### FCR-01: web3 1.6.x doesn't support `safe`/`finalized` in `eth_getBlockByNumber`, replaced by helper function.

Issue: The base node version in this repo is `node:12.22.2`, and the original web3.js version is 1.6.x. However, the `safe`/`finalized` tags are not supported in web3.js 1.6.x. To enable them, we can either upgrade the web3.js version or write a raw HTTP request wrapper for RPC. The goal here is to minimize the dependency tree for security and verifiability (see `HOW_TO_VERIFY.md` for more details), without sacrificing code readability.

Constraint:

1. Upgrading to web3 1.8.x requires a node version higher than 12.22.2. Upgrading the node version would break the existing build and involve a large change in the dependency tree, which is undesirable at the current stage. Since the goal is to maintain a minimal dependency tree, this option is out.
2. Replacing web3.js with viem: this option involves a larger dependency tree and codebase change than option 1, which is undesirable at the current stage. However, migrating to viem is necessary in the long term and is already in the execution plan.

- Every web3 `>= 1.8.0` transitively pulls `@noble/hashes`, which does `require('node:crypto')`.
  The `node:` import scheme needs **Node ≥ 14.18**. Our image is pinned to **`node:12`** by
  digest (`Dockerfile`), so on 1.8.0+ `require('web3')` crashes at startup with
  `Cannot find module 'node:crypto'` (chain: `web3-utils` → `@ethereumjs/util@8` →
  `ethereum-cryptography@2` → `@noble/curves` → `@noble/hashes/cryptoNode.js`). Verified in a
  real `node:12` container across 1.8.0 / 1.8.2 / 1.9.0 / 1.10.4 — all crash. **No web3 version
  gives us `safe`/`finalized` _and_ runs on Node 12.**

- Bumping the base image to Node ≥ 14.18 would widen the verification trust surface (new base
  digest, new Debian snapshot, a rebuilt dependency tree) for zero functional gain here.
- Switching to viem is a non-starter on Node 12 (needs Node 18+) and a monorepo-wide rewrite of
  ~75 web3 call sites plus the shared `commons` package.

Solution:

1. `rawGetBlockByTag`: A thin helper that issues `eth_getBlockByNumber('<tag>', false)` with the tag string, sent through `web3.currentProvider.send(payload, cb)`. The only thing bypassed is web3js's client-side input formatter. It decodes `.number` from hex (raw JSON-RPC returns hex; `web3.eth.getBlock` returns a number, and callers do arithmetic on `.number`) and returns `null` when the node has no block for the tag.

### FCR-02: verify if `safe` tag is supported by EL RPC during initialization.

Issue: Before FCR is implemented, passing the `safe` block tag will either return an error or return a block that is neither fast-confirmed nor finalized. There needs to be a way to ensure that the RPC source supports the `safe` tag.

Solution:
During initialization in `initialize()` (`src/watcher.js`), check whether the `safe` block is supported using the logic below, and demote to `block-finality` if `safe` is not supported:

1. **Probe `safe`**: call `rawGetBlockByTag(web3, 'safe')`. Treat both a thrown error and a `null` return as a failed attempt (unsupported clients may return either). Retry up to `SAFE_BLOCK_PROBE_RETRIES` (10) with `SAFE_BLOCK_PROBE_DELAY_MS` (5000ms) between attempts.
   - If `safe` never resolves → probe `rawGetBlockByTag(web3, 'finalized')` the same way.
     - finalized resolves → `{ supported: false, reason: 'safe-unavailable-finalized-ok' }` → **demote**.
     - finalized also fails → `{ supported: false, fatal: true, reason: 'all-rpc-failed' }`.
2. **Gap check**: if `safe` resolves, read `latest` (`rawGetBlockByTag(web3, 'latest')`) and
   compute `latest.number - safe.number`.
   - gap `< SAFE_BLOCK_MAX_GAP` (32) → `{ supported: true, safe, latest }` → proceed in fcr.
   - gap `>= 32` → `{ supported: false, reason: 'gap-too-large', safe, latest }` → **demote**.
     > 32-block threshold: 32 blocks is ~1 epoch on Ethereum and ~2 epochs on Gnosis Chain. Although there's no official `SAFE_BLOCK_MAX_GAP` value to verify against, `32` is a reasonable number.

## ToDo List

- [x] Code
- [x] Unit Test
- [ ] Integration test
- [ ] Docker compose

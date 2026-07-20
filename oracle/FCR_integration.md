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
| `src/tx/web3.js`                     | `getBlockNumber(web3, type)` now supports `type` = `latest` \| `safe` \| `finalized`.                                                                                                                                                                                                                                                                                                                                                                               |
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

- **No checker-specific env vars** — `fcrTxsChecker` derives which chain(s) to validate
  from the two mode vars, and each chain's web3/finality from `config.main`.
- Added to `.env.example`, `.env.example.xdai`, `.env.example.amb`.
- When either side is `fcr`, run the checker: `yarn validator:fcr-txs`.

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

## ToDo List

- [x] Code
- [x] Unit Test
- [ ] Integration test
- [ ] Docker compose

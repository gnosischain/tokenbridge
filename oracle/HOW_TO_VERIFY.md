# How to Verify a Published Oracle Image

Step-by-step. For the full reasoning, see [`VERIFICATION_DETAILS.md`](./VERIFICATION_DETAILS.md).

## Inputs you need (obtain from a trusted, out-of-band channel)

- `VERIFIER_SHA` — commit SHA of the audited `verify.sh` to run (the tool).
- `VERSION` — release tag to check, e.g. `v3.11.0` (the subject).
- `EXPECTED_SOURCE_COMMIT` — commit SHA `VERSION` must resolve to.

## Prerequisites

- `docker` (with `buildx`), `git`, `jq`, `tar`, `sha256sum` (or `shasum -a 256`), `sed`.
- ~3 GB free disk; network to Docker Hub and `github.com`.
- Non-amd64 hosts (Apple Silicon): enable `linux/amd64` emulation in Docker Desktop.

## Steps

1. Download the tool, pinned to its commit:

   ```bash
   curl -fsSL \
     https://raw.githubusercontent.com/gnosischain/tokenbridge/<VERIFIER_SCRIPT_SHA>/oracle/verify.sh \
     -o verify.sh
   ```

2. Run it against the release, asserting the expected source commit:
   ```bash
   bash verify.sh <VERSION> <EXPECTED_SOURCE_COMMIT>
   ```

## Result

- `✅ VERIFICATION PASSED` → image at `<VERSION>` was built from `<EXPECTED_SOURCE_COMMIT>`; files under `/mono` are byte-identical.
- `❌ VERIFICATION FAILED` → differences under `/mono`, or tag does not resolve to `<EXPECTED_SOURCE_COMMIT>`. Do not deploy; investigate.

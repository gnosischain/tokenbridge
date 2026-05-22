# How to Reproduce the Docker Image Verification

This is the self-contained procedure for verifying that the Docker image published at `docker.io/gnosischain/tokenbridge-oracle:v3.11.0` was built from this repository at git tag `v3.11.0`. Starting from `git clone`, end-to-end takes ~10 minutes on a modern machine. The procedure rebuilds the image locally and compares it, file by file, to what is published on Docker Hub.

The example below pins the **`v3.11.0`** release. To verify a different tag, replace `v3.11.0` everywhere and re-resolve the base-image digest in Step 3.

> The verification was first executed and recorded on **2026-05-21**. Expected reference values from that run — image digests, build timestamps, file counts, `yarn.lock` hash, layer count — are listed in **Appendix A**. The SLSA provenance fields the image ships with are summarized in **Appendix B**. Limitations of this approach (and the stronger Options 2/3 we plan to adopt) are in **Appendix C**.

---

## What you are verifying

You are answering one question:

> Does the image at `docker.io/gnosischain/tokenbridge-oracle:v3.11.0` actually contain the source code from this repo at git tag `v3.11.0` — and nothing else?

Concretely, by the end of this procedure you will have proved that:

- Every application file under `/mono` in the published image is **byte-identical** to the source at tag `v3.11.0` after a clean build.
- Every resolved `node_modules` dependency (including native modules compiled by `node-gyp` during `yarn install`) is byte-identical.
- `yarn.lock` is byte-identical.
- The base image used by CI is the same `node:12` digest you used locally.
- The 30 image layers were created by the **same `docker build` commands** in the same order.

What this does **not** prove:

- That `v3.11.0` is a safe or correct release. This is a build-integrity check, not a code review.
- That the GitHub Actions runner that produced the published image was not compromised. (A malicious build that produced the same bytes from the same source would still pass.)
- That the **release tag itself is authentic.** `v3.11.0` is an unsigned tag — a force-push or a compromised maintainer account could move it to a different commit, and `git clone --branch v3.11.0` would happily fetch the new content. Both the manual procedure and `verify.sh` (which defaults `ALLOW_UNSIGNED_TAG=1` for this reason) trust the tag's current state on the remote. The path forward is signed tags + `cosign verify-attestation` on the SLSA provenance — see Appendix C.
- That the **SLSA provenance read in Step 3 is authentic.** A malicious registry could in principle serve a self-consistent fake provenance pointing at a different base-image digest; the rebuild would still match byte-for-byte against the fake, and verification would pass. Run `verify.sh` with `COSIGN_KEY=<maintainer-pubkey>` once cosign signing lands (Appendix C, Option 3) to close this gap.
- That image IDs / manifest digests match. They won't — Docker embeds wall-clock timestamps in the image config. We verify **filesystem content equivalence** instead, which is the strongest claim achievable without `SOURCE_DATE_EPOCH` and pinned apt snapshots.

---

## Prerequisites

You need a machine with:

- **Docker** with `buildx` (Docker Desktop 4.x or Docker Engine 20.10+).
- **git** 2.5+ (for `git worktree`).
- `jq`, `shasum` (or `sha256sum`), `tar`, `diff`, `find`, `xargs` — standard on macOS and Linux.
- ~3 GB free disk for the build cache and exported filesystems.
- Network access to Docker Hub and `github.com`.

If you are on Apple Silicon (M1/M2/M3/M4), Docker will emulate `linux/amd64` via QEMU; the build is slower but the bytes are identical.

---

## Step-by-step reproduction

### Step 1 — Clone the repo

```bash
git clone https://github.com/gnosischain/tokenbridge.git
cd tokenbridge
```

**Expect:** the clone completes; `git log --oneline -1` shows the latest `master` commit.

### Step 2 — Pin a clean worktree at the release tag

We don't want local edits or untracked files to leak into the build context, so we check the tag out into a throwaway worktree:

```bash
git worktree add /tmp/tokenbridge-v3.11.0 v3.11.0
```

**Expect:** `Preparing worktree (detached HEAD at <sha>)`. After this, `/tmp/tokenbridge-v3.11.0` contains exactly the source at tag `v3.11.0`.

### Step 3 — Read the base-image digest from the published provenance

The Dockerfile says `FROM node:12` — a floating tag whose contents change over time. CI resolved it to a specific digest at build time, recorded in the SLSA provenance attached to the published image. We need to use the same digest, otherwise we're testing two different `node:12` snapshots against each other.

```bash
docker buildx imagetools inspect \
  --format '{{json .Provenance}}' \
  gnosischain/tokenbridge-oracle:v3.11.0 \
  | jq -r '.SLSA.buildDefinition.resolvedDependencies[0].digest.sha256'
```

**Expect:** a single line — for `v3.11.0`, it must be:

```
01627afeb110b3054ba4a1405541ca095c8bfca1cb6f2be9479c767a2711879e
```

If you get something else, either (a) you queried the wrong tag, or (b) CI was re-run against a newer base image. In case (b), use the digest you got — the rest of the procedure still works, but the result is for whatever the registry currently advertises, not for the original `v3.11.0` build.

#### Why this specific digest — and how it connects to the build date

The digest above is **not a value we picked**, and it is **not "the current `node:12`."** It is whatever `node:12` resolved to on Docker Hub at the exact moment CI ran the `v3.11.0` build. The chain:

1. The `Publish Oracle Docker Image From Release` workflow fired on **2026-05-19 at 09:09:14 UTC** (the `startedOn` field in the published provenance — printed by the sanity-check command below, and recorded in Appendix A).
2. BuildKit, running inside that GitHub Actions job, asked Docker Hub to resolve the floating `node:12` tag. At that instant, Docker Hub pointed `node:12` at `sha256:01627afeb1…2711879e`.
3. BuildKit pulled that exact image, built the layers on top of it, and wrote the resolved digest into the SLSA `resolvedDependencies` field of the provenance attestation.
4. The final image and its provenance were pushed to Docker Hub together. Both are now immutable artifacts of that build.

So the answer to _"where does the digest come from?"_ is: **from the build itself, frozen in time inside the image's own provenance.** We are not choosing a Node version — we are reading the receipt CI left us. If you trigger a fresh CI build of the same source today, Docker Hub may have re-published `node:12` since 2026-05-19 (security patches, base-image refreshes, etc.), and the fresh build's provenance would record a _different_ digest. But the receipt for `v3.11.0` is permanent.

You can sanity-check the timing yourself:

```bash
docker buildx imagetools inspect --format '{{json .Provenance}}' \
  gnosischain/tokenbridge-oracle:v3.11.0 \
  | jq '.SLSA.runDetails.metadata | {startedOn, finishedOn}'
```

Expected output:

```json
{ "startedOn": "2026-05-19T09:09:14Z", "finishedOn": "2026-05-19T09:09:58Z" }
```

The 44-second window between those two timestamps is when `node:12` was resolved.

### Step 4 — Pin the base image in the worktree's Dockerfile

**Why we have to edit the Dockerfile at all.** The original `oracle/Dockerfile` line 1 reads `FROM node:12` — a _floating reference_. It tells Docker "look up whatever `node:12` means at the moment of the build." If you rebuild locally without pinning, Docker pulls **today's** `node:12` (a newer Node 12.x patch revision on a more recent Debian Stretch security snapshot, with a different `gcc`/`glibc`/`python` toolchain). The application source under `/mono/oracle` and `/mono/commons` would still match — those come from the git checkout — but every native module that `node-gyp` compiles during `yarn install` (e.g., `node_modules/**/build/Release/*.node`) would come out byte-different from CI's output. Step 8's `diff` would then show false-positive failures under `/mono/node_modules`, and you would not be able to tell drift from tampering.

Pinning the base image to the exact digest CI used eliminates that drift. The Dockerfile change is local-only — it lives in a throwaway worktree, never gets committed, and is reverted by `git worktree remove` in Cleanup.

Edit `/tmp/tokenbridge-v3.11.0/oracle/Dockerfile` line 1:

```diff
- FROM node:12
+ FROM node:12@sha256:01627afeb110b3054ba4a1405541ca095c8bfca1cb6f2be9479c767a2711879e
```

This is a one-line change. The rest of the Dockerfile is unmodified.

**Expect:** `git -C /tmp/tokenbridge-v3.11.0 diff oracle/Dockerfile` shows exactly the line above.

### Step 5 — Build the image locally with CI's exact flags

```bash
docker buildx build \
  --platform linux/amd64 \
  --no-cache \
  --provenance=false \
  --sbom=false \
  --load \
  -f /tmp/tokenbridge-v3.11.0/oracle/Dockerfile \
  -t oracle:verify \
  /tmp/tokenbridge-v3.11.0
```

Flag rationale:

- `--platform linux/amd64` — matches CI's runner architecture; required for byte-identical native modules.
- `--no-cache` — no inherited layers; every step runs fresh.
- `--provenance=false --sbom=false` — disables attestations so the local image is plain (we'll diff filesystems, not OCI metadata).
- `--load` — imports the result into the local Docker daemon so we can `docker create` from it.

**Expect:** the build runs through all stages and finishes with something like `=> => naming to docker.io/library/oracle:verify`. It takes ~5–10 min on an amd64 box, longer under emulation. Watch for warnings about apt: as long as the build doesn't fail, they're not fatal — the Debian Stretch archive is frozen and still serves the same content.

### Step 6 — Pull the published image at the matching platform

```bash
docker pull --platform linux/amd64 gnosischain/tokenbridge-oracle:v3.11.0
```

**Expect:** Docker downloads ~30 layers. The `--platform` flag matters on non-amd64 hosts; without it you may pull a variant that was never verified.

### Step 7 — Export both filesystems to disk

```bash
mkdir -p /tmp/oracle-verify/published-fs /tmp/oracle-verify/local-fs

docker export "$(docker create gnosischain/tokenbridge-oracle:v3.11.0)" \
  | tar -x -C /tmp/oracle-verify/published-fs

docker export "$(docker create oracle:verify)" \
  | tar -x -C /tmp/oracle-verify/local-fs
```

`docker export` flattens an image's layers into a single tar of the final filesystem. We extract both for direct comparison.

**Expect:** each directory ends up ~1.2 GB. `ls /tmp/oracle-verify/published-fs/mono` shows `commons`, `contracts`, `oracle`, `node_modules`, `package.json`, `yarn.lock`.

### Step 8 — Hash every file under `/mono` and diff

`/mono` is where the Dockerfile copies the application and installs dependencies. Everything outside `/mono` is base-image content (apt logs, system files, scratch dirs) and isn't expected to match exactly.

```bash
for side in published local; do
  ( cd /tmp/oracle-verify/${side}-fs/mono \
    && find . -type f -print0 \
    | xargs -0 shasum -a 256 \
    | sort -k2 \
    > /tmp/oracle-verify/${side}.all.hashes )
done

diff /tmp/oracle-verify/published.all.hashes /tmp/oracle-verify/local.all.hashes
```

**Expect:** `diff` exits silently with no output. That is the verification passing — **10,675 files hashed, zero differences**.

If you see differences, see "Troubleshooting" below.

### Step 9 (optional) — Cross-check layer commands

A second, complementary check: the image's layer history should match command-for-command.

```bash
docker history --no-trunc --format '{{.CreatedBy}}' \
  gnosischain/tokenbridge-oracle:v3.11.0 > /tmp/oracle-verify/published.history

docker history --no-trunc --format '{{.CreatedBy}}' \
  oracle:verify > /tmp/oracle-verify/local.history

diff /tmp/oracle-verify/published.history /tmp/oracle-verify/local.history
```

**Expect:** `diff` exits silently — identical line-for-line, 30 layers each.

### Step 10 (optional) — Spot-check `yarn.lock`

`yarn.lock` is the lock file resolved by `yarn install` during the build. If this matches, the dependency tree is identical:

```bash
shasum -a 256 /tmp/oracle-verify/published-fs/mono/yarn.lock \
              /tmp/oracle-verify/local-fs/mono/yarn.lock
```

**Expect:** both lines show the same digest:

```
559f4f66bd81642a8177bf772b9852cf1080cb63ff4d207d614ca6b648106b96
```

---

## How to interpret the result

| Outcome                                                                                                                                      | What it means                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 8 `diff` exits silently                                                                                                                 | ✅ The published image was built from this source. Deploy with confidence equal to the rebuild author's confidence in the GitHub Actions runner.                                                                                                                                   |
| Step 8 `diff` shows differences **only** in expected non-deterministic paths (`/var/log/apt/*`, `/tmp/yarn--*`, `/tmp/v8-compile-cache-0/*`) | ✅ Equivalent to a pass. These are build-time scratch files that contain timestamps but no executable code. **Note:** with the Step 8 command above (which scopes to `/mono`), you should not see these at all — they only appear if you re-scope the diff to the full filesystem. |
| Step 8 `diff` shows differences under `/mono/oracle`, `/mono/commons`, `/mono/contracts`, or `/mono/node_modules`                            | ❌ **Stop and investigate.** This is what a tampered image would look like. Capture the diff, do not deploy, file an issue.                                                                                                                                                        |

---

## Troubleshooting

**The build fails at `apt-get update`.**
Debian Stretch is past EOL; the archive moved to `archive.debian.org`. The Dockerfile already points at the archive (lines 4–7), so this should work — but transient network errors happen. Re-run Step 5.

**The build fails at `yarn install`.**
You're likely on a non-amd64 host without QEMU set up. Run:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```

then re-run Step 5.

**Differences appear inside `/mono/node_modules`.**
Most likely cause: you skipped Step 4 and built against the floating `node:12` tag, which has changed since the release. Re-do Step 3 and Step 4 with the digest from the published provenance.

**Differences appear inside `/mono/oracle` or `/mono/commons`.**
The worktree was checked out at the wrong commit, or local changes leaked in. Run `git -C /tmp/tokenbridge-v3.11.0 status` — only the `oracle/Dockerfile` edit from Step 4 should appear. If anything else is modified, blow away the worktree and start again at Step 2.

**Image IDs or manifest digests don't match.**
Expected. They never will without reproducible-build tooling (`SOURCE_DATE_EPOCH`, pinned apt snapshots, etc.) — Docker embeds wall-clock timestamps in the image config JSON, so two builds of identical source always produce different image IDs. This procedure verifies **filesystem content equivalence** (Step 8) instead, which is the strongest claim achievable without that tooling. The long-term fix is described in Appendix C.

---

## Cleanup

```bash
git worktree remove /tmp/tokenbridge-v3.11.0
rm -rf /tmp/oracle-verify
docker image rm oracle:verify gnosischain/tokenbridge-oracle:v3.11.0
```

---

## Verifying a different tag

To run this against, e.g., `v3.12.0`:

1. Replace every `v3.11.0` above with the new tag.
2. Re-resolve the base-image digest in Step 3 — CI may have built against a newer `node:12` snapshot.
3. Everything else is identical.

If you find a tag where the diff is non-empty under `/mono`, that is a finding worth reporting on the repo issue tracker.

---

## Verify index digest (lightweight mode)

A faster alternative to the full rebuild above: fetch the OCI **image index** for `v3.11.0` from Docker Hub and compare its SHA-256 against the value recorded by CI when the image was published. (`v3.11.0` is a multi-arch tag, so what the registry serves at this address is an image index — a.k.a. a Docker `manifest list` — pointing at the per-platform manifests, not a single-platform manifest itself.) This takes a few seconds, requires no local build, and needs only `curl`, `jq`, and `sha256sum`.

**Trust trade-off.** This mode trusts that the index digest recorded for `v3.11.0` (in Appendix A and in the GitHub Actions run log) reflects what CI actually built. If the GitHub Actions runner was compromised and pushed an index that matches the recorded value, this check will still pass. The full rebuild procedure above does not require that trust — it independently verifies filesystem content from source. Use this lightweight mode when you have already established confidence in the publishing pipeline; use the full procedure when you have not.

### Steps

```bash
# 1. Get an anonymous Docker Hub registry pull token.
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:gnosischain/tokenbridge-oracle:pull" | jq -r .token)

# 2. Fetch the OCI image index for the tag.
curl -sL \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/gnosischain/tokenbridge-oracle/manifests/v3.11.0" \
  > index.json

# 3. Hash the index.
sha256sum index.json
```

**Expect:** the digest equals the OCI index value recorded in Appendix A:

```
714adb52aea9ddfe5d7fc93ee3f763f4c5a91e19fc51b939568ed5a08ee4d00b  index.json
```

The two `Accept` headers in step 2 are required — without them the registry falls back to returning a single-platform manifest (e.g. `linux/amd64`), which hashes to a different, per-platform digest (the `70ded02d…` value in Appendix A for `v3.11.0`). The value above is the index digest covering all platforms and is what `docker pull` reports as `Digest:` for `v3.11.0`.

If the hash differs, the index currently served for `v3.11.0` does not match what CI recorded. Stop and investigate before deploying.

To verify a different tag, replace `v3.11.0` in step 2 and compare against the recorded index digest for that tag (not the value above).

---

## Appendix A — Reference values from the v3.11.0 verification run

These are the expected values for the first recorded execution of this procedure (2026-05-21). If you are verifying `v3.11.0`, your results should match every row in the table marked "expected to match." If you are verifying a different tag, only the procedure is the same — the values themselves will be tag-specific (re-derive them from your run).

| What it identifies                             | Value                                                                          | Expected to match?                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Tag verified                                   | `v3.11.0`                                                                      | —                                                             |
| CI build start (`startedOn`)                   | `2026-05-19T09:09:14Z`                                                         | yes (per-tag)                                                 |
| CI build finish (`finishedOn`)                 | `2026-05-19T09:09:58Z`                                                         | yes (per-tag)                                                 |
| Resolved base image (`node:12`)                | `sha256:01627afeb110b3054ba4a1405541ca095c8bfca1cb6f2be9479c767a2711879e`      | yes (per-tag)                                                 |
| OCI index (`docker pull` digest for `v3.11.0`) | `sha256:714adb52aea9ddfe5d7fc93ee3f763f4c5a91e19fc51b939568ed5a08ee4d00b`      | yes                                                           |
| Per-platform manifest (`linux/amd64`)          | `sha256:70ded02dbe3a0d047021fb673d351fca481b3591bdcb937a1c4b11d03bb32854`      | yes                                                           |
| Published Image ID (image config)              | `sha256:725e5c256d19404f21dcf28b699b7c1314bf11d13187c3d4ba5b3809087b6bfa`      | yes                                                           |
| Local rebuild Image ID                         | e.g. `sha256:a00b192ccb05eaabdc1f253e5240ff106fedb33613e35c9b985da3a65bd98bad` | **no — always differs** (wall-clock timestamp in config JSON) |
| Files under `/mono` (Step 8)                   | 10,675                                                                         | yes                                                           |
| Differences under `/mono` (Step 8)             | 0                                                                              | yes                                                           |
| `yarn.lock` SHA-256 (Step 10)                  | `559f4f66bd81642a8177bf772b9852cf1080cb63ff4d207d614ca6b648106b96`             | yes                                                           |
| Layer count (Step 9)                           | 30                                                                             | yes                                                           |
| Files outside `/mono` that legitimately differ | 17 (in `/var/log/apt`, `/tmp/yarn--*`, `/tmp/v8-compile-cache-0`)              | not in scope (Step 8 only diffs `/mono`)                      |

---

## Appendix B — What the published provenance contains

The image at `gnosischain/tokenbridge-oracle:v3.11.0` ships with a SLSA v1 provenance attestation generated by BuildKit during the GitHub Actions run. To inspect it directly:

```bash
docker buildx imagetools inspect --format '{{json .Provenance}}' \
  gnosischain/tokenbridge-oracle:v3.11.0 | jq
```

Key fields, with the values recorded for `v3.11.0`:

| Field                      | Value                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `buildType`                | `https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md` |
| `github_repository`        | `gnosischain/tokenbridge`                                                            |
| `github_workflow_ref`      | `gnosischain/tokenbridge/.github/workflows/oracle_build_image.yml@refs/heads/master` |
| `github_event_name`        | `workflow_run`                                                                       |
| `github_actor`             | `zengzengzenghuy`                                                                    |
| `builderPlatform`          | `linux/amd64`                                                                        |
| `startedOn` → `finishedOn` | `2026-05-19T09:09:14Z` → `09:09:58Z`                                                 |
| `resolvedDependencies[0]`  | `pkg:docker/node@12?platform=linux%2Famd64` digest `sha256:01627afeb1…2711879e`      |

**Known caveat:** `github_sha` is absent. For `workflow_run`-triggered builds, GitHub's environment variable points at the _triggering_ workflow's HEAD on the default branch rather than the release tag, so the provenance does not directly cite the source commit. This is the main reason an out-of-band content comparison (this document) is still needed today. The fix is in Appendix C.

---

## Appendix C — Limitations and the path forward

This procedure verifies build-integrity by **content comparison**. It is sufficient to detect tampered application bytes, but has known limitations:

- It cannot detect a compromised CI runner that produces identical bytes from the same source — that is, it doesn't independently attest _who_ built the image, only that the output matches the source.
- **The release tag is unsigned.** `v3.11.0` was published as a lightweight tag, so `git tag -v` cannot verify it. `verify.sh` therefore defaults to `ALLOW_UNSIGNED_TAG=1` and emits a warning. A force-pushed or retagged release would not be detected. Fix: future releases should be cut as annotated, GPG-signed tags from a maintainer key published in the repo; once that lands, run `ALLOW_UNSIGNED_TAG=0 ./verify.sh <tag>` to enforce the check.
- **The SLSA provenance is unsigned.** The base-image digest in Step 3 is read from whatever the registry serves; nothing in this procedure cryptographically binds it to the CI run that actually built the image. `verify.sh` accepts an optional `COSIGN_KEY` for this, but no key is published yet — see Option 3 below.
- It requires every consumer to rebuild locally (~10 min, ~3 GB disk) per release. There is no one-shot verify command.
- Image IDs and manifest digests are not reproducible (wall-clock timestamps in OCI config).

Two complementary approaches exist for stronger or easier verification, and are tracked separately in the repo:

**Bit-for-bit reproducible builds (Option 2).** Make `docker build` itself deterministic so two independent builds of the same source produce identical image digests. Verification then collapses to a single `sha256` comparison. Requires `SOURCE_DATE_EPOCH` plumbing, base-image digest pinning, apt-snapshot mirrors, and BuildKit `rewrite-timestamp=true`. High implementation cost, niche consumer benefit.

**Signed build provenance (Option 3).** The CI workflow signs the image at build time with cosign (keyless OIDC) and attaches a SLSA provenance attestation that cites the release commit, plus an SBOM. Consumers verify with one `cosign verify` call, no rebuild required. Low implementation cost (CI-only changes), high consumer-visible value. **This is the recommended next step.** Until it lands, this document remains the authoritative verification procedure.

---

## Appendix D — Repo artifacts referenced by this procedure

These files exist in the repository and are what the procedure verifies or depends on. You do not need to open them to run the procedure — they are listed only for navigation.

- `oracle/Dockerfile` — the build recipe being verified (Step 4 patches its first line locally).
- `.github/workflows/oracle_build_image.yml` — the CI workflow that produced the published image.
- `verify.sh` — an end-to-end automation of this procedure that runs on the host (no helper container — mounting the Docker socket into one would expand the trust boundary to every layer of that container's build). Requires the same host tools as the manual procedure (`docker` with `buildx`, `git`, `jq`, `tar`, `sha256sum`, `sed`). For `v3.11.0`, the script defaults `ALLOW_UNSIGNED_TAG=1` (the tag is not GPG-signed — see Appendix C) and runs without `COSIGN_KEY` (provenance attestation not verified — see Appendix C). Both gaps are printed at the end of every successful run. Use `./verify.sh` for the default tag v3.11.0.

# How to Verify the Docker Image Against the GitHub Release

This is the step-by-step procedure for verifying that a Docker image published at
`docker.io/gnosischain/tokenbridge-oracle:<TAG>` was built from this repository at the
matching git tag `<TAG>`. Starting from `git clone`, end-to-end takes ~10 minutes on a
modern machine. The procedure rebuilds the image locally and compares it, file by file,
to what is published on Docker Hub, and (in lightweight mode) checks the published digest
against what the GitHub Release records.

The procedure is **tag-agnostic**: every command is driven by the `$TAG` and `$IMAGE` shell
variables set in [Conventions](#conventions), and every digest is either read at runtime
(from the image's provenance) or looked up in the release's **Published image** block —
nothing is hardcoded. Substitute your own release tag wherever you see `$TAG`.

> Appendix A explains where to obtain each reference value at runtime; Appendix B summarizes
> the SLSA provenance fields the image ships with; Appendix C covers the limitations of this
> approach and the stronger Options 2/3 tracked in the repo.

---

## Conventions

Set these once in your shell; the rest of the procedure refers to them:

```bash
IMAGE=gnosischain/tokenbridge-oracle
TAG=vX.Y.Z                        # the release tag you want to verify
SOURCE_REPO=https://github.com/gnosischain/tokenbridge
SHA256="sha256sum"                # Linux/coreutils. On macOS use:  SHA256="shasum -a 256"
```

Three digests recur below. None is hardcoded in this document — each is obtained by a command:

| Variable          | What it is                                            | How it is obtained                                                 |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `$BASE_DIGEST`    | the `node:12` digest CI resolved at build time        | read from the image's SLSA provenance (Step 3)                     |
| `$RECORDED_DIGEST`| the index digest CI recorded for this release         | read from the release's **Published image** block (lightweight mode) |
| `$LIVE_DIGEST`    | the index digest the registry serves right now        | `docker buildx imagetools inspect "$IMAGE:$TAG"` (lightweight mode) |

---

## What you are verifying

You are answering one question:

> Does the image at `docker.io/$IMAGE:$TAG` actually contain the source code from this repo
> at git tag `$TAG` — and nothing else?

Concretely, by the end of this procedure you will have proved that:

- Every application file under `/mono` in the published image is **byte-identical** to the
  source at tag `$TAG` after a clean build.
- Every resolved `node_modules` dependency (including native modules compiled by `node-gyp`
  during `yarn install`) is byte-identical.
- `yarn.lock` is byte-identical.
- The base image used by CI is the same `node:12` digest (`$BASE_DIGEST`) you used locally.
- The image layers were created by the **same `docker build` commands** in the same order.

What this does **not** prove:

- That `$TAG` is a safe or correct release. This is a build-integrity check, not a code review.
- That the GitHub Actions runner that produced the published image was not compromised. (A
  malicious build that produced the same bytes from the same source would still pass.)
- That the **release tag itself is authentic.** If `$TAG` is an unsigned tag, a force-push or
  a compromised maintainer account could move it to a different commit, and
  `git clone --branch $TAG` would happily fetch the new content. Both the manual procedure and
  `verify.sh` (which defaults `ALLOW_UNSIGNED_TAG=1` for this reason) trust the tag's current
  state on the remote. The path forward is signed tags + `cosign verify-attestation` on the
  SLSA provenance — see Appendix C.
- That the **SLSA provenance read in Step 3 is authentic.** A malicious registry could in
  principle serve a self-consistent fake provenance pointing at a different base-image digest;
  the rebuild would still match byte-for-byte against the fake, and verification would pass.
  Signed provenance closes this gap — see Appendix C, Option 3.
- That image IDs / manifest digests match the *local rebuild*. They won't — Docker embeds
  wall-clock timestamps in the image config. We verify **filesystem content equivalence**
  instead, which is the strongest claim achievable without `SOURCE_DATE_EPOCH` and pinned apt
  snapshots. (Comparing the *published* index digest against the value CI recorded is a
  separate, lighter check — see [Verify index digest](#verify-index-digest-lightweight-mode).)

---

## Prerequisites

You need a machine with:

- **Docker** with `buildx` (Docker Desktop 4.x or Docker Engine 20.10+).
- **git** 2.5+ (for `git worktree`).
- `jq`, `tar`, `diff`, `find`, `xargs` — standard on Linux, macOS, and BSD.
- A SHA-256 CLI: `sha256sum` (Linux/coreutils) or `shasum -a 256` (macOS). Set `$SHA256` in
  [Conventions](#conventions) to whichever you have.
- Optional: `gh` (GitHub CLI) for the lightweight mode, to read the release body non-interactively.
- ~3 GB free disk for the build cache and exported filesystems.
- Network access to Docker Hub and `github.com`.

On any non-amd64 host (Apple Silicon, arm64 Linux, etc.), Docker emulates `linux/amd64` via
QEMU/binfmt; the build is slower but the bytes are identical.

---

## Step-by-step reproduction

### Step 1 — Clone the repo

```bash
git clone "$SOURCE_REPO" tokenbridge
cd tokenbridge
```

**Expect:** the clone completes; `git log --oneline -1` shows the latest `master` commit.

### Step 2 — Pin a clean worktree at the release tag

We don't want local edits or untracked files to leak into the build context, so we check the
tag out into a throwaway worktree:

```bash
WORKTREE=/tmp/tokenbridge-$TAG
git worktree add "$WORKTREE" "$TAG"
```

**Expect:** `Preparing worktree (detached HEAD at <sha>)`. After this, `$WORKTREE` contains
exactly the source at tag `$TAG`.

### Step 3 — Read the base-image digest from the published provenance

`oracle/Dockerfile` now pins the base image by digest (`FROM node:12@sha256:…`) for
reproducibility. CI still records the digest it actually resolved in the SLSA provenance
attached to the published image — that provenance is the source of truth for *what went into
the build*, so we read it and keep it as `$BASE_DIGEST`. Step 4 confirms the Dockerfile's pin
matches it. (For a tag cut *before* the Dockerfile was pinned, `FROM node:12` was a floating
tag, and `$BASE_DIGEST` is the only way to know which `node:12` snapshot CI used.)

```bash
BASE_DIGEST=$(docker buildx imagetools inspect --format '{{json .Provenance}}' "$IMAGE:$TAG" \
  | jq -r '.SLSA.buildDefinition.resolvedDependencies[]
           | select(.uri | startswith("pkg:docker/node"))
           | .digest.sha256')
echo "$BASE_DIGEST"
```

**Expect:** a single 64-hex-character line. Use whatever your command returns — it is the
receipt for the build you are verifying.

> The provenance digest and the Dockerfile's pinned digest should agree. If they don't, the
> published image was built from a different base than the committed Dockerfile claims — stop and
> investigate before trusting the image.

#### Why this digest comes from the build, not from us

The digest is **not a value we picked**, and it is **not "the current `node:12`."** It is
whatever `node:12` resolved to on Docker Hub at the exact moment CI ran the build for `$TAG`.
The chain:

1. The `Publish Oracle Docker Image From Release` workflow fired (the `startedOn` field in the
   published provenance — printed by the sanity-check command below).
2. BuildKit, running inside that GitHub Actions job, asked Docker Hub to resolve the floating
   `node:12` tag. At that instant, Docker Hub pointed `node:12` at `sha256:$BASE_DIGEST`.
3. BuildKit pulled that exact image, built the layers on top of it, and wrote the resolved
   digest into the SLSA `resolvedDependencies` field of the provenance attestation.
4. The final image and its provenance were pushed to Docker Hub together. Both are now
   immutable artifacts of that build.

So the answer to _"where does the digest come from?"_ is: **from the build itself, frozen in
time inside the image's own provenance.** We are not choosing a Node version — we are reading
the receipt CI left us. If you trigger a fresh CI build of the same source later, Docker Hub
may have re-published `node:12` in the meantime, and the fresh build's provenance would record
a _different_ digest. Each release's receipt is permanent and specific to that build.

You can sanity-check the timing yourself:

```bash
docker buildx imagetools inspect --format '{{json .Provenance}}' "$IMAGE:$TAG" \
  | jq '.SLSA.runDetails.metadata | {startedOn, finishedOn}'
```

The window between those two timestamps is when `node:12` was resolved.

### Step 4 — Confirm (or pin) the base image in the worktree

Because `oracle/Dockerfile` is pinned by digest, the local build already uses the exact base CI
used — **provided the Dockerfile's pin matches `$BASE_DIGEST` from Step 3.** Confirm it:

```bash
grep '^FROM node:12@sha256:' "$WORKTREE/oracle/Dockerfile"
# the digest shown must equal $BASE_DIGEST
```

If they match, skip to Step 5 — no edit needed.

**Older tags with a floating `FROM node:12`.** If you are verifying a tag cut *before* the
Dockerfile was pinned, line 1 is the floating `FROM node:12` and you must pin it locally, or the
rebuild drifts: Docker would pull **today's** `node:12` (a newer Node 12.x patch on a more recent
Debian Stretch snapshot, with a different `gcc`/`glibc`/`python` toolchain). The application
source under `/mono/oracle` and `/mono/commons` would still match — those come from the git
checkout — but every native module `node-gyp` compiles during `yarn install` (e.g.,
`node_modules/**/build/Release/*.node`) would come out byte-different from CI's output, and
Step 8's `diff` could not distinguish drift from tampering. The fix is local-only — it lives in
the throwaway worktree, is never committed, and is reverted by `git worktree remove` in Cleanup:

```bash
sed -i.bak -E \
  -e "s|^FROM[[:space:]]+node:12([[:space:]])|FROM node:12@sha256:$BASE_DIGEST\1|" \
  -e "s|^FROM[[:space:]]+node:12\$|FROM node:12@sha256:$BASE_DIGEST|" \
  "$WORKTREE/oracle/Dockerfile"
rm -f "$WORKTREE/oracle/Dockerfile.bak"
```

(Two passes, written to behave identically under both GNU `sed` (Linux) and BSD `sed`
(macOS/BSD), which differ in how they handle `$` inside an alternation. The pin is idempotent —
re-running it on an already-pinned line is a no-op.)

**Expect:** `git -C "$WORKTREE" diff oracle/Dockerfile` shows the `FROM` line gaining
`@sha256:<BASE_DIGEST>`.

### Step 5 — Build the image locally with CI's exact flags

```bash
docker buildx build \
  --platform linux/amd64 \
  --no-cache \
  --provenance=false \
  --sbom=false \
  --load \
  -f "$WORKTREE/oracle/Dockerfile" \
  -t "oracle:verify-$TAG" \
  "$WORKTREE"
```

Flag rationale:

- `--platform linux/amd64` — matches CI's runner architecture; required for byte-identical native modules.
- `--no-cache` — no inherited layers; every step runs fresh.
- `--provenance=false --sbom=false` — disables attestations so the local image is plain (we'll diff filesystems, not OCI metadata).
- `--load` — imports the result into the local Docker daemon so we can `docker create` from it.

**Expect:** the build runs through all stages and finishes with something like
`=> => naming to docker.io/library/oracle:verify-$TAG`. It takes ~5–10 min on an amd64 box,
longer under emulation. Watch for warnings about apt: as long as the build doesn't fail,
they're not fatal — the Debian Stretch archive is frozen and still serves the same content.

### Step 6 — Pull the published image at the matching platform

```bash
docker pull --platform linux/amd64 "$IMAGE:$TAG"
```

**Expect:** Docker downloads the image layers. The `--platform` flag matters on non-amd64
hosts; without it you may pull a variant that was never verified.

### Step 7 — Export both filesystems to disk

```bash
mkdir -p /tmp/oracle-verify/published-fs /tmp/oracle-verify/local-fs

docker export "$(docker create "$IMAGE:$TAG")" \
  | tar -x -C /tmp/oracle-verify/published-fs

docker export "$(docker create "oracle:verify-$TAG")" \
  | tar -x -C /tmp/oracle-verify/local-fs
```

`docker export` flattens an image's layers into a single tar of the final filesystem. We
extract both for direct comparison.

**Expect:** each directory ends up ~1.2 GB. `ls /tmp/oracle-verify/published-fs/mono` shows
`commons`, `contracts`, `oracle`, `node_modules`, `package.json`, `yarn.lock`.

### Step 8 — Hash every file under `/mono` and diff

`/mono` is where the Dockerfile copies the application and installs dependencies. Everything
outside `/mono` is base-image content (apt logs, system files, scratch dirs) and isn't
expected to match exactly.

```bash
for side in published local; do
  ( cd /tmp/oracle-verify/${side}-fs/mono \
    && find . -type f -print0 \
    | xargs -0 $SHA256 \
    | sort -k2 \
    > /tmp/oracle-verify/${side}.all.hashes )
done

diff /tmp/oracle-verify/published.all.hashes /tmp/oracle-verify/local.all.hashes
```

**Expect:** `diff` exits silently with no output. That is the verification passing — every file
under `/mono` hashes identically. (The file count is source-dependent; the *zero differences* is
what matters.)

If you see differences, see "Troubleshooting" below.

### Step 9 (optional) — Cross-check layer commands

A second, complementary check: the image's layer history should match command-for-command.

```bash
docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE:$TAG" \
  > /tmp/oracle-verify/published.history

docker history --no-trunc --format '{{.CreatedBy}}' "oracle:verify-$TAG" \
  > /tmp/oracle-verify/local.history

diff /tmp/oracle-verify/published.history /tmp/oracle-verify/local.history
```

**Expect:** `diff` exits silently — identical line-for-line, same layer count on both sides.

### Step 10 (optional) — Spot-check `yarn.lock`

`yarn.lock` is the lock file resolved by `yarn install` during the build. If this matches, the
dependency tree is identical:

```bash
$SHA256 /tmp/oracle-verify/published-fs/mono/yarn.lock \
        /tmp/oracle-verify/local-fs/mono/yarn.lock
```

**Expect:** both lines show the same digest. `yarn.lock` is committed to the repo, so this hash
is stable across rebuilds of the same tag.

---

## How to interpret the result

| Outcome                                                                                                                                      | What it means                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 8 `diff` exits silently                                                                                                                 | ✅ The published image was built from this source. Deploy with confidence equal to the rebuild author's confidence in the GitHub Actions runner.                                                                                                                                   |
| Step 8 `diff` shows differences **only** in expected non-deterministic paths (`/var/log/apt/*`, `/tmp/yarn--*`, `/tmp/v8-compile-cache-0/*`) | ✅ Equivalent to a pass. These are build-time scratch files that contain timestamps but no executable code. **Note:** with the Step 8 command above (which scopes to `/mono`), you should not see these at all — they only appear if you re-scope the diff to the full filesystem. |
| Step 8 `diff` shows differences under `/mono/oracle`, `/mono/commons`, `/mono/contracts`, or `/mono/node_modules`                            | ❌ **Stop and investigate.** This is what a tampered image would look like. Capture the diff, do not deploy, file an issue.                                                                                                                                                        |

If you find a tag where the Step 8 diff is non-empty under `/mono`, that is a finding worth
reporting on the repo issue tracker.

---

## Troubleshooting

**The build fails at `apt-get update`.**
Debian Stretch is past EOL; the archive moved to `archive.debian.org`. The Dockerfile already
points at the archive, so this should work — but transient network errors happen. Re-run Step 5.

**The build fails at `yarn install`.**
You're likely on a non-amd64 host without QEMU set up. Run:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```

then re-run Step 5.

**Differences appear inside `/mono/node_modules`.**
Most likely cause: you skipped Step 4 and built against the floating `node:12` tag, which has
changed since the release. Re-do Step 3 and Step 4 with the digest from the published provenance.

**Differences appear inside `/mono/oracle` or `/mono/commons`.**
The worktree was checked out at the wrong commit, or local changes leaked in. Run
`git -C "$WORKTREE" status` — only the `oracle/Dockerfile` edit from Step 4 should appear. If
anything else is modified, blow away the worktree and start again at Step 2.

**Image IDs or manifest digests don't match the local rebuild.**
Expected. They never will without reproducible-build tooling (`SOURCE_DATE_EPOCH`, pinned apt
snapshots, etc.) — Docker embeds wall-clock timestamps in the image config JSON, so two builds
of identical source always produce different image IDs. This procedure verifies **filesystem
content equivalence** (Step 8) instead. The long-term fix is described in Appendix C.

---

## Cleanup

```bash
git worktree remove "$WORKTREE"
rm -rf /tmp/oracle-verify
docker image rm "oracle:verify-$TAG" "$IMAGE:$TAG"
```

---

## Verify index digest (lightweight mode)

A faster alternative to the full rebuild above: compare the **index digest** the registry
currently serves for `$TAG` against the digest CI recorded when it published the image. This
takes a few seconds and requires no local build.

Since the `feat(ci): record commit→digest binding on Oracle release` change, the publish
workflow writes a **Published image** block into the GitHub Release body for each tag,
containing the image, the index digest, and the source commit. That block is the durable
record — unlike the Actions run log, which is purged after the repo's retention window
(~90 days). This is the value to compare against.

**Trust trade-off.** This mode trusts that the recorded digest reflects what CI actually built;
it is a plaintext record, not a cryptographic signature. It defends against a tag being
re-pushed to a different image after release, but not against a compromised CI runner, and it
leans on GitHub's release-edit permissions/audit log to keep the recorded value honest. The
full rebuild procedure above does not require that trust — it independently verifies filesystem
content from source. Use lightweight mode when you have already established confidence in the
publishing pipeline; use the full procedure when you have not.

### Steps

**1. Read the recorded digest from the release's "Published image" block.** With the GitHub CLI:

```bash
RECORDED_DIGEST=$(gh release view "$TAG" --repo gnosischain/tokenbridge --json body \
  --jq '.body' | grep -oE 'sha256:[0-9a-f]{64}' | head -1)
echo "$RECORDED_DIGEST"
```

Or just open the release page on GitHub and copy the `digest:` line under **Published image**.

**2. Resolve the digest the registry serves right now:**

```bash
LIVE_DIGEST=$(docker buildx imagetools inspect "$IMAGE:$TAG" --format '{{.Manifest.Digest}}')
echo "$LIVE_DIGEST"
```

This is the index (a.k.a. `manifest list`) digest — the same value `docker pull` reports as
`Digest:` — covering all platforms, not a single-platform manifest.

**3. Compare:**

```bash
[ "$LIVE_DIGEST" = "$RECORDED_DIGEST" ] && echo match || echo MISMATCH
```

`match` → the image currently served at `$TAG` is exactly the one CI recorded. `MISMATCH` →
the tag has been re-pointed to a different image since release. **Stop and investigate before
deploying.**

### Docker-free fallback

If you can't use `docker`/`gh`, fetch the index manifest directly and hash it, then compare to
the recorded digest by eye:

```bash
# 1. Anonymous Docker Hub registry pull token.
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$IMAGE:pull" | jq -r .token)

# 2. Fetch the OCI image index for the tag (both Accept headers are required, or the
#    registry returns a single-platform manifest with a different, per-platform digest).
curl -sL \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/$IMAGE/manifests/$TAG" \
  > index.json

# 3. Hash the index — this equals the `sha256:` in $RECORDED_DIGEST.
$SHA256 index.json
```

---

## Appendix A — Reference values

All per-build values change every time a tag is rebuilt, so none are hardcoded here — obtain
them at runtime:

| Value                                | Where to obtain it                                                          |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Resolved base image (`node:12`)      | Step 3 (`$BASE_DIGEST`) — from the image's SLSA provenance                  |
| OCI index (`docker pull`) digest     | Lightweight mode (`$RECORDED_DIGEST` / `$LIVE_DIGEST`) — release body & registry |
| CI build window (`startedOn`/`finishedOn`) | Step 3 sanity-check command — from the provenance                     |
| Published Image ID (image config)    | `docker buildx imagetools inspect "$IMAGE:$TAG" --format '{{.Manifest.Digest}}'` (note: **not reproducible** locally) |

A few values are **source-derived** and therefore stable across rebuilds of the *same* tag — the
file count under `/mono` (Step 8), the `yarn.lock` SHA-256 (Step 10), and the layer count
(Step 9). On your first trusted verification of a tag, record these as a baseline; a later run
that is diff-clean but shows a different file or layer count is worth investigating.

---

## Appendix B — What the published provenance contains

The image ships with a SLSA v1 provenance attestation generated by BuildKit during the GitHub
Actions run. To inspect it directly:

```bash
docker buildx imagetools inspect --format '{{json .Provenance}}' "$IMAGE:$TAG" | jq
```

Key fields. Repo-level fields are stable across builds; per-build fields (actor, build window,
resolved base digest) change on every build:

| Field                      | Value / source                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `buildType`                | `https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md` |
| `github_repository`        | `gnosischain/tokenbridge`                                                            |
| `github_workflow_ref`      | `gnosischain/tokenbridge/.github/workflows/oracle_build_image.yml@refs/heads/master` |
| `github_event_name`        | `workflow_run`                                                                       |
| `github_actor`             | the GitHub user who triggered the build (per-build)                                  |
| `builderPlatform`          | `linux/amd64`                                                                        |
| `startedOn` → `finishedOn` | the build window (per-build)                                                         |
| `resolvedDependencies[*]`  | `pkg:docker/node@12?platform=linux%2Famd64` digest `sha256:$BASE_DIGEST`             |

**Known caveat:** `github_sha` is absent. For `workflow_run`-triggered builds, GitHub's
environment variable points at the _triggering_ workflow's HEAD on the default branch rather
than the release tag, so the provenance does not directly cite the source commit. The
`record commit→digest binding` change works around this by writing the source commit into the
release's **Published image** block (see lightweight mode), so the commit↔digest link now
exists out-of-band — though still as a plaintext record, not a signed attestation. The
cryptographic fix is in Appendix C.

---

## Appendix C — Limitations and the path forward

This procedure verifies build-integrity by **content comparison**. It is sufficient to detect
tampered application bytes, but has known limitations:

- It cannot detect a compromised CI runner that produces identical bytes from the same source —
  that is, it doesn't independently attest _who_ built the image, only that the output matches
  the source.
- **The release tag may be unsigned.** A lightweight tag cannot be checked with `git tag -v`.
  `verify.sh` therefore defaults to `ALLOW_UNSIGNED_TAG=1` and emits a warning. A force-pushed
  or retagged release would not be detected. Fix: cut releases as annotated, signed tags from a
  maintainer key, then run `ALLOW_UNSIGNED_TAG=0 ./verify.sh "$TAG"` to enforce the check. (The
  longer-term direction is cosign keyless signing on the image — Option 3 below — which makes
  tag/commit authenticity verifiable without a maintainer GPG keyring.)
- **The SLSA provenance is unsigned.** The base-image digest in Step 3 is read from whatever the
  registry serves; nothing in this procedure cryptographically binds it to the CI run that
  actually built the image. Signed provenance closes this gap — see Option 3 below.
- **The recorded index digest is unsigned.** The lightweight-mode comparison trusts a plaintext
  record in the release body. It detects post-publish tag tampering, not a malicious publish.
- It requires every consumer to rebuild locally (~10 min, ~3 GB disk) per release for the strong
  check. There is no one-shot, cryptographically-backed verify command yet.
- Image IDs and manifest digests are not reproducible (wall-clock timestamps in OCI config).

Two complementary approaches exist for stronger or easier verification, and are tracked
separately in the repo:

**Bit-for-bit reproducible builds (Option 2).** Make `docker build` itself deterministic so two
independent builds of the same source produce identical image digests. Verification then
collapses to a single `sha256` comparison. Requires `SOURCE_DATE_EPOCH` plumbing, base-image
digest pinning (✅ done — `oracle/Dockerfile` now pins `node:12` by digest), apt-snapshot
mirrors, and BuildKit `rewrite-timestamp=true`. High implementation cost, niche consumer benefit.

**Signed build provenance (Option 3).** The CI workflow signs the image at build time with
cosign (keyless OIDC) and attaches a SLSA provenance attestation that cites the release commit,
plus an SBOM. Consumers verify with one `cosign verify` call, no rebuild required. Low
implementation cost (CI-only changes), high consumer-visible value. **This is the recommended
next step.** Until it lands, this document remains the authoritative verification procedure.

---

## Appendix D — Repo artifacts referenced by this procedure

These files exist in the repository and are what the procedure verifies or depends on. You do
not need to open them to run the procedure — they are listed only for navigation.

- `oracle/Dockerfile` — the build recipe being verified; pins `node:12` by digest (Step 4
  confirms the pin, or patches a floating `FROM` locally for older tags).
- `.github/workflows/oracle_build_image.yml` — the CI workflow that produced the published image
  and (since the binding change) records the commit→digest mapping in the release body.
- `verify.sh` — an end-to-end automation of this procedure that runs on the host (no helper
  container — mounting the Docker socket into one would expand the trust boundary to every layer
  of that container's build). Requires the same host tools as the manual procedure (`docker` with
  `buildx`, `git`, `jq`, `tar`, `sha256sum`, `sed`). It defaults `ALLOW_UNSIGNED_TAG=1` (the tag
  may not be signed — see Appendix C); it reads the SLSA provenance but does not independently
  authenticate it (see Appendix C). Both gaps are printed at the end of every successful run. Run
  `./verify.sh <TAG>` to verify a specific release tag.

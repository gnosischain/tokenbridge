# Verifying the Oracle Image — Details

Reference for verifying that `docker.io/gnosischain/tokenbridge-oracle:<TAG>` was built from
this repo at git tag `<TAG>`. For quick way to verify, use [`HOW_TO_VERIFY.md`](./HOW_TO_VERIFY.md)+ `verify.sh`.
This doc covers the manual procedure, the trust model, and the limitations.

Three checks, in order of cost. Run the first two on every release (each proves a
different thing); the full rebuild is the periodic trust-nothing audit:

| Check                           | Cost    | Proves                                                          |
| ------------------------------- | ------- | --------------------------------------------------------------- |
| **Fast** — digest vs record     | seconds | The served image == the one CI recorded. Catches re-pointing.   |
| **Signature** — `cosign verify` | seconds | The image was built/signed by the CI pipeline. Catches forgery. |
| **Full** — rebuild + diff       | ~10 min | Image contents == this source at `<TAG>`. Catches tampering.    |

## Conventions

```bash
IMAGE=gnosischain/tokenbridge-oracle
TAG=vX.Y.Z
EXPECTED_SOURCE_COMMIT=<commit the tag must resolve to, obtained out-of-band>
SOURCE_REPO=https://github.com/gnosischain/tokenbridge
SHA256="sha256sum"                # macOS: SHA256="shasum -a 256"
```

Digests are never hardcoded; each is read at runtime:

| Variable              | What it is                                      | Source                            |
| --------------------- | ----------------------------------------------- | --------------------------------- |
| `$BASE_DIGEST`        | `node:12` digest CI resolved at build time      | SLSA provenance (Full, Step 2)    |
| `$RECORDED_DIGEST`    | index digest CI recorded for the release        | release **Published image** block |
| `$LIVE_DIGEST`        | index digest the registry serves now            | `imagetools inspect`              |
| `$ATTESTATION_DIGEST` | per-platform attestation-manifest digest (signed) | `imagetools inspect` of the index |

## What the checks do NOT prove

- That `<TAG>` is a safe/correct release — this is build integrity, not code review.
- That the CI runner was uncompromised — identical bytes from the same source still pass, and
  the cosign signature only proves the pipeline signed it, not that the pipeline was honest.
- Authenticity of the **tag** — trusted as served by the remote; pin the commit with
  `EXPECTED_SOURCE_COMMIT`. (The provenance and the digest->builder link ARE authenticated by
  the signature check for releases after v3.10.0; the recorded commit↔digest binding in the
  Release body remains plaintext.)
- That image IDs / manifest digests match the local rebuild — they never will (wall-clock
  timestamps in OCI config). The full check compares **filesystem content** instead.

---

## Fast check — digest vs. recorded

Confirm the registry serves the exact image CI recorded for the tag.

```bash
# Digest CI recorded (release "Published image" block):
RECORDED_DIGEST=$(gh release view "$TAG" --repo gnosischain/tokenbridge --json body \
  --jq '.body' | grep -oE 'sha256:[0-9a-f]{64}' | head -1)

# Digest the registry serves now (the index/manifest-list digest, all platforms):
LIVE_DIGEST=$(docker buildx imagetools inspect "$IMAGE:$TAG" --format '{{.Manifest.Digest}}')

[ "$LIVE_DIGEST" = "$RECORDED_DIGEST" ] && echo match || echo MISMATCH
```

`match` → done. `MISMATCH` → tag re-pointed since release; **stop and investigate.**

No `gh`? Read `digest:` from the release page by eye. No `docker`/`gh`? Hash the index directly:

```bash
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$IMAGE:pull" | jq -r .token)
curl -sL -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/$IMAGE/manifests/$TAG" > index.json
$SHA256 index.json     # equals $RECORDED_DIGEST
```

**Trust:** the recorded digest is a plaintext record, not a signature. Defends against post-publish
re-pointing, not a malicious publish. Pair it with the signature check below; use the full check
if you don't trust the pipeline at all.

---

## Signature check — `cosign verify`

The build pipeline (Docker's `github-builder` reusable workflow) signs the image's attestation
manifests with keyless cosign on every push. Verifying the signature proves the digest was
produced by that workflow running on GitHub Actions, with the trust anchor in the public
Sigstore transparency log — it authenticates what the fast check and the provenance reads
(Full, Step 2) otherwise take on faith from the registry.

Command and details: [`HOW_TO_VERIFY.md` §2](./HOW_TO_VERIFY.md). The signatures live on the
per-platform **attestation manifests**, not on the index — so verify against
`$ATTESTATION_DIGEST` (the `attestation-manifest` entries you read out of the index with
`imagetools inspect`), never the tag and never `$RECORDED_DIGEST` (that index digest only tells
you _which_ index to enumerate the attestation manifests from).

**Trust:** the certificate identity is the _reusable_ workflow
(`docker/github-builder/.github/workflows/build.yml@...`), which any repository could call —
the binding to _this repo's_ build comes cryptographically from the
`--certificate-github-workflow-repository gnosischain/tokenbridge` pin already included in
the §2 command, while `$RECORDED_DIGEST` is what binds that index back to the release commit.
The signature attests _who
built_ the image, not _what is in_ it (that is the full check), and says nothing about whether
the CI runner itself was compromised. Tags v3.10.0 and older predate the signing pipeline and
fail with "no matching signatures".

---

## Full check — rebuild from source

Independently rebuilds the image and compares it, file-by-file, to what is published.

**Requires:** `docker` (+`buildx`), `git` 2.5+, `jq`, `tar`, a SHA-256 CLI, `sed`; ~3 GB disk;
network to Docker Hub + github.com. Non-amd64 hosts run `linux/amd64` under emulation (Docker
Desktop: enable Rosetta/QEMU).

### 1. Clean worktree at the tag

```bash
git clone "$SOURCE_REPO" tokenbridge && cd tokenbridge
WORKTREE=/tmp/tokenbridge-$TAG
git worktree add "$WORKTREE" "$TAG"
# Confirm the tag resolves to the commit you trust — else it was re-pointed; stop.
[ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$EXPECTED_SOURCE_COMMIT" ] || echo "TAG MOVED — STOP"
```

### 2. Read the base-image digest from provenance

CI records the `node:12` digest it resolved in the image's SLSA provenance — the source of truth
for what went into the build. Extract just the dependency list (not the whole document, which
embeds a git commit message that can carry a raw newline jq ≥ 1.7 rejects). The lookup path
varies along two axes: **multi-platform** images (current pipeline) key provenance by platform
(`(index .Provenance "linux/amd64").SLSA`), single-platform images (older tags) expose it at
`.Provenance.SLSA`; and the base lives under `buildDefinition.resolvedDependencies` in SLSA v1.0
(newer BuildKit) vs `materials` in v0.2. Try in that order until one returns non-null:

```bash
for FMT in \
  '{{json (index .Provenance "linux/amd64").SLSA.buildDefinition.resolvedDependencies}}' \
  '{{json (index .Provenance "linux/amd64").SLSA.materials}}' \
  '{{json .Provenance.SLSA.buildDefinition.resolvedDependencies}}' \
  '{{json .Provenance.SLSA.materials}}'; do
  DEPS=$(docker buildx imagetools inspect --format "$FMT" "$IMAGE:$TAG" 2>/dev/null) \
    && [ -n "$DEPS" ] && [ "$DEPS" != null ] && break
done
BASE_DIGEST=$(echo "$DEPS" | jq -r '.[] | select(.uri | startswith("pkg:docker/node")) | .digest.sha256')
```

Optional timing sanity-check (same platform-layout and v1.0/v0.2 splits; substitute
`runDetails.metadata` / `metadata` for the dependency paths above):

```bash
echo "$META" | jq '{startedOn, finishedOn, buildStartedOn, buildFinishedOn}'
```

### 3. Confirm (or pin) the base image

`oracle/Dockerfile` pins `node:12` by digest. Confirm the pin matches `$BASE_DIGEST`:

```bash
grep '^FROM node:12@sha256:' "$WORKTREE/oracle/Dockerfile"   # digest must equal $BASE_DIGEST
```

Mismatch → published image used a different base than the committed Dockerfile claims; stop.

**Older tags** with a floating `FROM node:12` must be pinned locally (else native modules drift):

```bash
sed -i.bak -E \
  -e "s|^FROM[[:space:]]+node:12([[:space:]])|FROM node:12@sha256:$BASE_DIGEST\1|" \
  -e "s|^FROM[[:space:]]+node:12\$|FROM node:12@sha256:$BASE_DIGEST|" \
  "$WORKTREE/oracle/Dockerfile" && rm -f "$WORKTREE/oracle/Dockerfile.bak"
```

### 4. Build locally with CI's flags

```bash
docker buildx build --platform linux/amd64 --no-cache --provenance=false --sbom=false --load \
  -f "$WORKTREE/oracle/Dockerfile" -t "oracle:verify-$TAG" "$WORKTREE"
```

`--no-cache` (fresh layers), `--provenance=false --sbom=false` (plain image to diff), `--load`
(import to daemon). ~5–10 min on amd64, longer under emulation. apt warnings are non-fatal.

### 5. Pull the published image, export both filesystems

```bash
docker pull --platform linux/amd64 "$IMAGE:$TAG"
mkdir -p /tmp/oracle-verify/{published,local}-fs
docker export "$(docker create "$IMAGE:$TAG")"        | tar -x -C /tmp/oracle-verify/published-fs
docker export "$(docker create "oracle:verify-$TAG")" | tar -x -C /tmp/oracle-verify/local-fs
```

### 6. Hash everything under `/mono` and diff

`/mono` holds the app + installed deps; everything else is base-image content.

```bash
for s in published local; do
  ( cd /tmp/oracle-verify/$s-fs/mono && find . -type f -print0 | xargs -0 $SHA256 | sort -k2 \
    > /tmp/oracle-verify/$s.hashes )
done
diff /tmp/oracle-verify/published.hashes /tmp/oracle-verify/local.hashes
```

Silent `diff` = **pass**: every file under `/mono` is byte-identical.

### Optional cross-checks

```bash
# Layer commands match line-for-line:
diff <(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE:$TAG") \
     <(docker history --no-trunc --format '{{.CreatedBy}}' "oracle:verify-$TAG")
# yarn.lock identical:
$SHA256 /tmp/oracle-verify/{published,local}-fs/mono/yarn.lock
```

### Cleanup

```bash
git worktree remove "$WORKTREE"; rm -rf /tmp/oracle-verify
docker image rm "oracle:verify-$TAG" "$IMAGE:$TAG"
```

### Interpreting the diff

| Step 6 diff                                                       | Meaning                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| Silent                                                            | ✅ Built from this source.                            |
| Differences under `/mono/{oracle,commons,contracts,node_modules}` | ❌ Tampering signature. Do not deploy; file an issue. |

Differences only under `/mono/node_modules` usually mean a skipped/incorrect base-image pin
(Step 3). Differences under `/mono/oracle` or `/mono/commons` mean a wrong checkout or leaked
local changes — re-check `git -C "$WORKTREE" status` and redo from Step 1.

### Troubleshooting

- **`apt-get update` fails** — Stretch is EOL; the Dockerfile already targets `archive.debian.org`.
  Retry Step 4 (transient network).
- **`yarn install` fails** — non-amd64 host without `linux/amd64` emulation; enable Rosetta/QEMU
  in Docker Desktop and retry.

---

## Automation — `verify.sh`

`verify.sh <TAG> <EXPECTED_SOURCE_COMMIT>` runs the full check end-to-end (clone → pin base →
build → export → diff) and prints a PASS/FAIL summary.

- **`EXPECTED_SOURCE_COMMIT`** — asserts the tag resolves to a commit you obtained out-of-band, before the build. Turns "trust the tag" into "trust this commit". Without
  it, an attacker who re-points the tag to a malicious commit **and** publishes a matching image
  passes the diff — the rebuild only proves image-matches-its-source, not that the source is the
  one you trust. Pinning is a strict superset: it still catches a registry-only image swap.
  As an extra early-warning signal, Step 2 also cross-checks the commit recorded in the image's
  provenance (`vcs.revision`) against this value; the authoritative source→image proof remains the
  rebuild and diff.
- **Runs on the host, no helper container** Mounting the Docker socket into a helper
  would give it root-equivalent control of the daemon, expanding the trust boundary to that
  container's own image and build inputs — the opposite of what a verifier should do. The cost is
  that the host needs the tools listed above (and amd64 emulation on Apple Silicon); the script
  probes for them and stops with guidance rather than registering anything privileged itself.

Exit codes: `0` pass · `1` filesystem diff under `/mono` (possible tampering) · `2` preflight or
supply-chain check failed before the build.

## Limitations & path forward

The full check is content comparison; the _who built it_ gap it leaves is now covered by the
[signature check](#signature-check--cosign-verify) (keyless cosign signing came for free when
the build moved to Docker's `github-builder` reusable workflow). What still relies on trust:
the tag/commit (pin with `EXPECTED_SOURCE_COMMIT`), the plaintext commit↔digest record in the
Release body, and the honesty of the CI runner (see
[What the checks do NOT prove](#what-the-checks-do-not-prove)). `verify.sh` prints these gaps on
every run.

## Appendix — provenance fields

```bash
docker buildx imagetools inspect --format '{{json .Provenance}}' "$IMAGE:$TAG" | jq
```

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| `buildType`               | buildkit SLSA                                                  |
| `github_repository`       | `gnosischain/tokenbridge`                                      |
| `github_workflow_ref`     | `…/.github/workflows/oracle_build_image.yml@refs/heads/master` |
| `builderPlatform`         | `linux/amd64`                                                  |
| `startedOn`→`finishedOn`  | build window (per-build)                                       |
| `resolvedDependencies[*]` | `pkg:docker/node@12` digest `sha256:$BASE_DIGEST`              |

Field names above are SLSA v1.0 (newer BuildKit). Older tags use SLSA v0.2: `resolvedDependencies`
→ `materials`, `startedOn`/`finishedOn` → `buildStartedOn`/`buildFinishedOn`, and `vcs.revision`
sits under the `https://mobyproject.org/buildkit@v1#metadata` key.

**Caveat:** `github_sha` is absent — for `workflow_run` builds it points at the default branch, not
the tag. The commit↔digest link is instead written into the release **Published image** block. That
record is plaintext: the signature check authenticates digest→builder, but the digest→commit binding
still rests on the Release body (cross-checked by `verify.sh` against provenance `vcs.revision`).

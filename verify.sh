#!/usr/bin/env bash
#
# verify.sh — automates the "Full check" in oracle/VERIFICATION_DETAILS.md:
# rebuild the image from source and diff it, file-by-file, against what is
# published. Runs on the host by design (no helper container) to keep the
# trust boundary tight. See VERIFICATION_DETAILS.md for rationale and limits.
#
# Host requirements: docker (+buildx), git, jq, tar, sha256sum, sed.
# Non-amd64 hosts need linux/amd64 emulation (Docker Desktop enables it); the
# script probes for it and stops with guidance if missing.
#
# Usage:
#   ./verify.sh <TAG> <EXPECTED_SOURCE_COMMIT>
#     <TAG>                    published release tag to verify against its source
#     <EXPECTED_SOURCE_COMMIT> commit SHA the tag MUST resolve to, obtained
#                            out-of-band. Required: without it a tag re-pointed to a
#                            matching malicious image would still pass — the rebuild
#                            only proves image-matches-its-source, not that the source
#                            is the one you trust. Accepts a full or abbreviated SHA.
#
# Optional environment variables:
#   SOURCE_REPO            git remote URL          (default: gnosischain/tokenbridge)
#   IMAGE_REPO             image repository        (default: gnosischain/tokenbridge-oracle)
#   BASE_IMAGE_PKG         purl prefix used to find the base image in SLSA
#                          resolvedDependencies    (default: pkg:docker/node)
#   BASE_IMAGE_FROM_NAME   token to pin in the Dockerfile FROM line
#                                                  (default: node:12)
#
# Exit codes:
#   0   verification passed
#   1   verification failed (filesystem diff under /mono — possible tampering)
#   2   preflight or supply-chain check failed before the build started

set -euo pipefail

TAG="${1:-}"
EXPECTED_SOURCE_COMMIT="${2:-}"
if [[ -z "$TAG" || -z "$EXPECTED_SOURCE_COMMIT" ]]; then
  echo "Usage: $0 <TAG> <EXPECTED_SOURCE_COMMIT>" >&2
  echo "  EXPECTED_SOURCE_COMMIT is required: without it a tag re-pointed to a matching" >&2
  echo "  malicious image would still pass. Obtain the commit out-of-band." >&2
  echo "  See oracle/VERIFICATION_DETAILS.md." >&2
  exit 2
fi
SOURCE_REPO="${SOURCE_REPO:-https://github.com/gnosischain/tokenbridge.git}"
IMAGE_REPO="${IMAGE_REPO:-gnosischain/tokenbridge-oracle}"
BASE_IMAGE_PKG="${BASE_IMAGE_PKG:-pkg:docker/node}"
BASE_IMAGE_FROM_NAME="${BASE_IMAGE_FROM_NAME:-node:12}"

# --- Host preflight ----------------------------------------------------------

missing=()
for tool in docker git jq tar sha256sum sed; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: missing required host tools: ${missing[*]}" >&2
  echo "       Install them and re-run." >&2
  exit 2
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "ERROR: docker buildx plugin is required (Docker Desktop 4.x / Engine 20.10+)." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not reachable. Is Docker running?" >&2
  exit 2
fi

# Need linux/amd64 emulation on non-amd64 hosts.
HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "x86_64" && "$HOST_ARCH" != "amd64" ]]; then
  echo "Host architecture is $HOST_ARCH — checking linux/amd64 emulation..."
  if ! docker run --rm --platform linux/amd64 hello-world >/dev/null 2>&1; then
    echo "ERROR: this $HOST_ARCH host cannot run linux/amd64 images." >&2
    echo "       This script builds and compares a linux/amd64 image, which needs" >&2
    echo "       QEMU amd64 emulation registered with the Docker daemon." >&2
    echo >&2
    echo "       Docker Desktop enables this by default — if you use it, ensure" >&2
    echo "       'Use Rosetta for x86_64/amd64 emulation' (or QEMU) is on under" >&2
    echo "       Settings > General, restart the daemon, and re-run this script." >&2
    exit 2
  fi
  echo "linux/amd64 emulation OK."
fi

WORKDIR="$(mktemp -d -t tokenbridge-verify-XXXXXX)"
echo "Workdir (auto-cleaned on exit): $WORKDIR"

cleanup() {
  echo
  echo "Cleaning up workdir..."
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# --- Step 1: clone source ----------------------------------------------------

echo
echo "=== Step 1: clone $SOURCE_REPO @ $TAG ==="
git clone --quiet --depth=1 --branch "$TAG" "$SOURCE_REPO" "$WORKDIR/src"
SOURCE_COMMIT=$(git -C "$WORKDIR/src" rev-parse HEAD)
echo "Cloned commit: $SOURCE_COMMIT"

# Pin the subject: a tag is mutable on the remote, so assert it resolves to the
# commit supplied out-of-band — otherwise a moved tag + matching malicious image
# would pass. Prefix match accepts a short SHA.
exp=$(echo "$EXPECTED_SOURCE_COMMIT" | tr '[:upper:]' '[:lower:]')
got=$(echo "$SOURCE_COMMIT" | tr '[:upper:]' '[:lower:]')
if [[ "$got" != "$exp"* ]]; then
  echo "ERROR: tag '$TAG' resolves to a different commit than expected." >&2
  echo "       expected: $EXPECTED_SOURCE_COMMIT" >&2
  echo "       resolved: $SOURCE_COMMIT" >&2
  echo "       The tag may have been re-pointed on the remote. Stop and investigate." >&2
  exit 2
fi
echo "Tag resolves to expected commit ($EXPECTED_SOURCE_COMMIT)."

# --- Step 2: resolve base-image digest from SLSA provenance ------------------

echo
echo "=== Step 2: resolve base-image digest from published SLSA provenance ==="
# Extract only the needed fields, not the whole document: the full provenance
# embeds the git commit message, which BuildKit sometimes emits with a raw
# newline (invalid JSON that jq >= 1.7 rejects).
#
# The lookup path varies along two axes:
#   - platform layout: single-platform images expose provenance at
#     .Provenance.SLSA; multi-platform images key it by platform, so the
#     linux/amd64 slice (the one rebuilt below) lives at
#     (index .Provenance "linux/amd64").SLSA.
#   - SLSA version: the base image is under buildDefinition.resolvedDependencies
#     in v1.0 and materials in v0.2.
# prov_field tries each format in order and returns the first non-null hit; a
# format that doesn't apply makes imagetools exit non-zero or print null/empty,
# both of which mean "try the next one".
prov_field() {
  local fmt out
  for fmt in "$@"; do
    if out=$(docker buildx imagetools inspect --format "$fmt" "$IMAGE_REPO:$TAG" 2>/dev/null) \
      && [[ -n "$out" && "$out" != "null" ]]; then
      printf '%s\n' "$out"
      return 0
    fi
  done
  echo "null"
}

DEPS=$(prov_field \
  '{{json (index .Provenance "linux/amd64").SLSA.buildDefinition.resolvedDependencies}}' \
  '{{json (index .Provenance "linux/amd64").SLSA.materials}}' \
  '{{json .Provenance.SLSA.buildDefinition.resolvedDependencies}}' \
  '{{json .Provenance.SLSA.materials}}')

# Filter the base image by purl prefix rather than trusting index [0]; BuildKit
# does not guarantee dependency ordering.
NODE_DIGESTS=$(echo "$DEPS" \
  | jq -r --arg pkg "$BASE_IMAGE_PKG" '
      .[]?
      | select(.uri | startswith($pkg))
      | .digest.sha256
    ')

if [[ -z "$NODE_DIGESTS" ]]; then
  echo "ERROR: no dependency matching '$BASE_IMAGE_PKG' found in provenance for $IMAGE_REPO:$TAG." >&2
  echo "       Either the image has no SLSA provenance, or the base-image purl prefix changed." >&2
  echo "       Adjust BASE_IMAGE_PKG and re-run." >&2
  exit 2
fi

MATCH_COUNT=$(echo "$NODE_DIGESTS" | wc -l | tr -d ' ')
if (( MATCH_COUNT > 1 )); then
  echo "ERROR: multiple dependencies matched '$BASE_IMAGE_PKG':" >&2
  echo "$NODE_DIGESTS" >&2
  echo "       Tighten BASE_IMAGE_PKG to disambiguate." >&2
  exit 2
fi

NODE_DIGEST="$NODE_DIGESTS"

# Build metadata: timestamps and the VCS revision the image claims, with the
# same platform-layout and v1.0/v0.2 path splits as above.
META=$(prov_field \
  '{{json (index .Provenance "linux/amd64").SLSA.runDetails.metadata}}' \
  '{{json (index .Provenance "linux/amd64").SLSA.metadata}}' \
  '{{json .Provenance.SLSA.runDetails.metadata}}' \
  '{{json .Provenance.SLSA.metadata}}')
STARTED=$(echo "$META" | jq -r '.startedOn // .buildStartedOn // "unknown"')
FINISHED=$(echo "$META" | jq -r '.finishedOn // .buildFinishedOn // "unknown"')
echo "CI build window: $STARTED -> $FINISHED"
echo "Resolved base:   ${BASE_IMAGE_FROM_NAME}@sha256:$NODE_DIGEST"

# Cross-check the commit the image claims against EXPECTED_SOURCE_COMMIT — an
# early-warning signal only, since the authoritative source->image proof is the
# rebuild in Steps 3-8. Revision is under buildkit_metadata.vcs in v1.0, under
# the 'https://mobyproject.org/buildkit@v1#metadata' key in v0.2.
PROV_REVISION=$(echo "$META" | jq -r '
  .buildkit_metadata.vcs.revision
  // ."https://mobyproject.org/buildkit@v1#metadata".vcs.revision
  // "unknown"')
if [[ "$PROV_REVISION" == "unknown" ]]; then
  echo "WARNING: provenance records no VCS revision; skipping image-claimed-commit cross-check." >&2
else
  # 'exp' is the lowercased EXPECTED_SOURCE_COMMIT from Step 1; prefix match accepts a short SHA.
  prov_got=$(echo "$PROV_REVISION" | tr '[:upper:]' '[:lower:]')
  if [[ "$prov_got" != "$exp"* ]]; then
    echo "ERROR: the published image's provenance claims a different source commit than expected." >&2
    echo "       expected (EXPECTED_SOURCE_COMMIT): $EXPECTED_SOURCE_COMMIT" >&2
    echo "       provenance VCS revision:           $PROV_REVISION" >&2
    echo "       The image was built from a different commit than the one you trust." >&2
    echo "       Stop and investigate before trusting it." >&2
    exit 2
  fi
  echo "Provenance VCS revision matches expected commit ($PROV_REVISION)."
fi

# --- Step 2b: provenance trust caveat ----------------------------------------

echo
echo "NOTE: provenance is trusted as served by the registry, not independently" >&2
echo "      authenticated. See VERIFICATION_DETAILS.md, Limitations (signed provenance)." >&2

# --- Step 3: confirm (or pin) the base image in the cloned Dockerfile --------

echo
echo "=== Step 3: confirm (or pin) '$BASE_IMAGE_FROM_NAME' in oracle/Dockerfile ==="
DF="$WORKDIR/src/oracle/Dockerfile"

# oracle/Dockerfile pins the base by digest. Current tags: confirm the pin
# equals the provenance digest (mismatch = finding). Older tags with a floating
# 'FROM node:12': pin locally so the rebuild can't drift. See VERIFICATION_DETAILS.md.
EXISTING_PIN=""
if pin_line=$(grep -oE "^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}@sha256:[0-9a-f]{64}" "$DF" | head -1); then
  EXISTING_PIN="${pin_line##*@}"   # -> sha256:<hex>
fi

if [[ -n "$EXISTING_PIN" ]]; then
  # Already pinned — confirm it matches the provenance digest from Step 2.
  if [[ "$EXISTING_PIN" == "sha256:${NODE_DIGEST}" ]]; then
    echo "Dockerfile already pins ${BASE_IMAGE_FROM_NAME}@${EXISTING_PIN} — matches provenance. No edit needed."
  else
    echo "ERROR: base-image mismatch between the Dockerfile and the provenance." >&2
    echo "       oracle/Dockerfile pins:  ${BASE_IMAGE_FROM_NAME}@${EXISTING_PIN}" >&2
    echo "       provenance (Step 2) has: ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}" >&2
    echo "       The published image was built from a different base than the" >&2
    echo "       committed Dockerfile claims. Stop and investigate before trusting it." >&2
    exit 2
  fi
else
  # Floating 'FROM node:12' (older tag): pin locally. Two passes (whitespace
  # case, then EOL case) keep '$' out of an alternation, for BSD sed (macOS).
  # Does not match fully-qualified or ARG-driven FROM lines — see hard-fail below.
  sed -i.bak -E \
    -e "s|^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}([[:space:]])|FROM ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}\1|" \
    -e "s|^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}\$|FROM ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}|" \
    "$DF"
  rm -f "${DF}.bak"

  # Fail now if the pin didn't land, rather than after a ~10 min build.
  if ! grep -q "@sha256:${NODE_DIGEST}" "$DF"; then
    echo "ERROR: failed to pin '$BASE_IMAGE_FROM_NAME' in $DF." >&2
    echo "       The FROM line may have changed shape upstream (fully-qualified" >&2
    echo "       name, multi-stage alias variant, ARG-driven version). Inspect the" >&2
    echo "       Dockerfile and pin manually, or adjust BASE_IMAGE_FROM_NAME." >&2
    exit 2
  fi

  git -C "$WORKDIR/src" --no-pager diff oracle/Dockerfile
fi

# --- Step 4: build locally with CI's flags -----------------------------------

echo
echo "=== Step 4: build the image locally with CI's flags (~5-10 min) ==="
docker buildx build \
  --platform linux/amd64 \
  --no-cache \
  --provenance=false \
  --sbom=false \
  --load \
  -f "$DF" \
  -t "oracle:verify-$TAG" \
  "$WORKDIR/src"

# --- Step 5: pull the published image ----------------------------------------

echo
echo "=== Step 5: pull the published image ==="
docker pull --platform linux/amd64 "$IMAGE_REPO:$TAG"

# --- Step 6: export both filesystems -----------------------------------------

echo
echo "=== Step 6: export both filesystems ==="
mkdir -p "$WORKDIR/pub-fs" "$WORKDIR/loc-fs"

PUB_CID=$(docker create "$IMAGE_REPO:$TAG")
docker export "$PUB_CID" | tar -x -C "$WORKDIR/pub-fs"
docker rm "$PUB_CID" >/dev/null

LOC_CID=$(docker create "oracle:verify-$TAG")
docker export "$LOC_CID" | tar -x -C "$WORKDIR/loc-fs"
docker rm "$LOC_CID" >/dev/null

# --- Step 7: hash every file under /mono and diff ----------------------------

echo
echo "=== Step 7: hash every file under /mono in both filesystems ==="
for side in pub loc; do
  ( cd "$WORKDIR/${side}-fs/mono" \
    && find . -type f -print0 \
    | xargs -0 sha256sum \
    | sort -k2 \
    > "$WORKDIR/${side}.hashes" )
done
echo "Hashed pub: $(wc -l < "$WORKDIR/pub.hashes" | tr -d ' ') files"
echo "Hashed loc: $(wc -l < "$WORKDIR/loc.hashes" | tr -d ' ') files"

echo
echo "=== Step 8: diff hash manifests ==="
if diff -q "$WORKDIR/pub.hashes" "$WORKDIR/loc.hashes" >/dev/null; then
  COUNT=$(wc -l < "$WORKDIR/pub.hashes" | tr -d ' ')
  echo
  echo "================================================================"
  echo "  ✅  VERIFICATION PASSED"
  echo "  $COUNT files under /mono are byte-identical."
  echo
  echo "  Tag:           $TAG"
  echo "  Source commit: $SOURCE_COMMIT"
  echo "  Source repo:   $SOURCE_REPO"
  echo "  Image:         $IMAGE_REPO:$TAG"
  echo "  Base image:    ${BASE_IMAGE_FROM_NAME}@sha256:$NODE_DIGEST"
  echo "  CI build:      $STARTED -> $FINISHED"
  echo
  echo "  What this run did NOT verify (see oracle/VERIFICATION_DETAILS.md, Limitations):"
  echo "    - That EXPECTED_SOURCE_COMMIT is the commit you intend (the supplied value is"
  echo "      trusted as-is; obtain it from a trusted, out-of-band source)."
  echo "    - SLSA provenance authenticity (read from the registry, not independently verified)."
  echo "    - That the CI runner producing the published image was uncompromised."
  echo "================================================================"
  RESULT=0
else
  echo
  echo "================================================================"
  echo "  ❌  VERIFICATION FAILED"
  echo "  Differences detected under /mono."
  echo "  This is the signature of a tampered image. DO NOT DEPLOY."
  echo "  First 50 lines of diff:"
  echo "================================================================"
  diff "$WORKDIR/pub.hashes" "$WORKDIR/loc.hashes" | head -50
  RESULT=1
fi

docker image rm "oracle:verify-$TAG" >/dev/null 2>&1 || true
exit $RESULT

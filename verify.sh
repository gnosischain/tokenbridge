#!/usr/bin/env bash
#
# verify.sh — reproduce the verification documented in HOW_TO_VERIFY.md
# end-to-end on the host. No helper container is used: mounting the host
# Docker socket into a container would give that container root-equivalent
# control over the daemon, expanding the trust boundary to every layer of
# its build (Ubuntu image, apt mirrors, Docker's apt repo, this script's
# cloned source). Running on the host keeps the trust boundary tight.
#
# Host requirements:
#   docker (with the buildx plugin), git, jq, tar, sha256sum, sed
#   On non-amd64 hosts, the script registers binfmt automatically.
#
# Usage:
#   ./verify.sh                       # verify the default tag (v3.11.0): https://hub.docker.com/layers/gnosischain/tokenbridge-oracle/v3.11.0/images/sha256-70ded02dbe3a0d047021fb673d351fca481b3591bdcb937a1c4b11d03bb32854
#   ./verify.sh v3.12.0               # verify a different release tag
#
# Optional environment variables:
#   SOURCE_REPO            git remote URL          (default: gnosischain/tokenbridge)
#   IMAGE_REPO             image repository        (default: gnosischain/tokenbridge-oracle)
#   BASE_IMAGE_PKG         purl prefix used to find the base image in SLSA
#                          resolvedDependencies    (default: pkg:docker/node)
#   BASE_IMAGE_FROM_NAME   token to pin in the Dockerfile FROM line
#                                                  (default: node:12)
#   ALLOW_UNSIGNED_TAG     defaults to 1 because the v3.11.0 release tag is
#                          unsigned (see HOW_TO_VERIFY.md, Appendix C, for
#                          the limitation this introduces and the planned
#                          fix). Set to 0 to enforce `git tag -v`; that
#                          requires a future signed release plus the
#                          maintainer's public key in your GPG keyring.
#   COSIGN_KEY             path or URL to the maintainer's public key. When
#                          set, the SLSA provenance attestation is verified
#                          with `cosign verify-attestation` before the base-
#                          image digest is trusted. When unset, the script
#                          warns and continues — provenance authenticity is
#                          NOT checked and a malicious registry could in
#                          principle serve self-consistent fake provenance.
#
# Exit codes:
#   0   verification passed
#   1   verification failed (filesystem diff under /mono — possible tampering)
#   2   preflight or supply-chain check failed before the build started

set -euo pipefail

TAG="${1:-v3.11.0}"
SOURCE_REPO="${SOURCE_REPO:-https://github.com/gnosischain/tokenbridge.git}"
IMAGE_REPO="${IMAGE_REPO:-gnosischain/tokenbridge-oracle}"
BASE_IMAGE_PKG="${BASE_IMAGE_PKG:-pkg:docker/node}"
BASE_IMAGE_FROM_NAME="${BASE_IMAGE_FROM_NAME:-node:12}"
ALLOW_UNSIGNED_TAG="${ALLOW_UNSIGNED_TAG:-1}"
COSIGN_KEY="${COSIGN_KEY:-}"

# --- Host preflight ----------------------------------------------------------

missing=()
for tool in docker git jq tar sha256sum sed; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ -n "$COSIGN_KEY" ]] && ! command -v cosign >/dev/null 2>&1; then
  missing+=("cosign")
fi
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

# Apple Silicon / arm hosts need binfmt registered so the host daemon can
# run linux/amd64 builds under QEMU. Idempotent — no-op if already set up.
HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "x86_64" && "$HOST_ARCH" != "amd64" ]]; then
  echo "Host architecture is $HOST_ARCH — registering binfmt for linux/amd64 emulation..."
  docker run --privileged --rm tonistiigi/binfmt --install amd64 >/dev/null
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

# --- Step 2: verify the release tag is signed --------------------------------

echo
echo "=== Step 2: verify GPG signature on tag $TAG ==="
if git -C "$WORKDIR/src" tag -v "$TAG" 2>&1; then
  echo "Tag signature verified."
else
  if [[ "$ALLOW_UNSIGNED_TAG" == "1" ]]; then
    echo "WARNING: tag '$TAG' is unsigned. Continuing (ALLOW_UNSIGNED_TAG=1, the default)." >&2
    echo "         Without a signature, a force-pushed or retagged release on the" >&2
    echo "         remote could deceive this verification. v3.11.0 is unsigned;" >&2
    echo "         see HOW_TO_VERIFY.md Appendix C for the limitation and the" >&2
    echo "         planned move to signed tags + cosign attestations." >&2
  else
    echo "ERROR: tag '$TAG' is unsigned or its signature could not be verified." >&2
    echo "       Import the maintainer's public key (gpg --recv-keys ...) and re-run," >&2
    echo "       or set ALLOW_UNSIGNED_TAG=1 to accept the limitation documented in" >&2
    echo "       HOW_TO_VERIFY.md Appendix C." >&2
    exit 2
  fi
fi

# --- Step 3: resolve base-image digest from SLSA provenance ------------------

echo
echo "=== Step 3: resolve base-image digest from published SLSA provenance ==="
PROV_JSON=$(docker buildx imagetools inspect \
  --format '{{json .Provenance}}' \
  "$IMAGE_REPO:$TAG")

# Filter resolvedDependencies by purl prefix rather than trusting index [0].
# BuildKit does not guarantee dependency ordering across versions.
NODE_DIGESTS=$(echo "$PROV_JSON" \
  | jq -r --arg pkg "$BASE_IMAGE_PKG" '
      .SLSA.buildDefinition.resolvedDependencies[]?
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
STARTED=$(echo "$PROV_JSON" | jq -r '.SLSA.runDetails.metadata.startedOn // "unknown"')
FINISHED=$(echo "$PROV_JSON" | jq -r '.SLSA.runDetails.metadata.finishedOn // "unknown"')
echo "CI build window: $STARTED -> $FINISHED"
echo "Resolved base:   ${BASE_IMAGE_FROM_NAME}@sha256:$NODE_DIGEST"

# --- Step 3b (optional): verify provenance signature with cosign -------------

if [[ -n "$COSIGN_KEY" ]]; then
  echo
  echo "=== Step 3b: verify SLSA provenance signature with cosign ==="
  cosign verify-attestation \
    --key "$COSIGN_KEY" \
    --type slsaprovenance \
    "$IMAGE_REPO:$TAG" >/dev/null
  echo "Provenance attestation signature verified against $COSIGN_KEY."
else
  echo
  echo "WARNING: COSIGN_KEY not set — the provenance read above is trusted from" >&2
  echo "         the registry's word. A malicious registry could serve self-" >&2
  echo "         consistent fake provenance pointing at a fake base image, and" >&2
  echo "         the byte-for-byte rebuild check below would still pass against" >&2
  echo "         that fake. Set COSIGN_KEY=<maintainer-pubkey> to close this gap." >&2
fi

# --- Step 4: pin the FROM line in the cloned Dockerfile ----------------------

echo
echo "=== Step 4: pin '$BASE_IMAGE_FROM_NAME' in oracle/Dockerfile ==="
DF="$WORKDIR/src/oracle/Dockerfile"

# Flexible regex: matches 'FROM node:12', 'FROM node:12 AS builder', and
# preserves whatever follows. Does NOT match fully-qualified forms
# (docker.io/library/node:12) or ARG-driven versions — those would require
# manual review anyway. Two passes avoid putting '$' inside an alternation
# group, which BSD sed (macOS) does not handle. Pass 1 catches the
# 'followed by whitespace' case; pass 2 catches the 'end of line' case.
# After pass 1 matches, the line no longer ends in '${BASE_IMAGE_FROM_NAME}',
# so pass 2 is a no-op — the two passes don't double-pin.
sed -i.bak -E \
  -e "s|^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}([[:space:]])|FROM ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}\1|" \
  -e "s|^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}\$|FROM ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}|" \
  "$DF"
rm -f "${DF}.bak"

# Hard-fail if the pin didn't actually land — silent no-op would leave the
# build pulling the floating tag and only fail loudly at Step 8, by which
# point ~10 min of build time has been wasted.
if ! grep -q "@sha256:${NODE_DIGEST}" "$DF"; then
  echo "ERROR: failed to pin '$BASE_IMAGE_FROM_NAME' in $DF." >&2
  echo "       The FROM line may have changed shape upstream (fully-qualified" >&2
  echo "       name, multi-stage alias variant, ARG-driven version). Inspect the" >&2
  echo "       Dockerfile and pin manually, or adjust BASE_IMAGE_FROM_NAME." >&2
  exit 2
fi

git -C "$WORKDIR/src" --no-pager diff oracle/Dockerfile

# --- Step 5: build locally with CI's flags -----------------------------------

echo
echo "=== Step 5: build the image locally with CI's flags (~5-10 min) ==="
docker buildx build \
  --platform linux/amd64 \
  --no-cache \
  --provenance=false \
  --sbom=false \
  --load \
  -f "$DF" \
  -t "oracle:verify-$TAG" \
  "$WORKDIR/src"

# --- Step 6: pull the published image ----------------------------------------

echo
echo "=== Step 6: pull the published image ==="
docker pull --platform linux/amd64 "$IMAGE_REPO:$TAG"

# --- Step 7: export both filesystems -----------------------------------------

echo
echo "=== Step 7: export both filesystems ==="
mkdir -p "$WORKDIR/pub-fs" "$WORKDIR/loc-fs"

PUB_CID=$(docker create "$IMAGE_REPO:$TAG")
docker export "$PUB_CID" | tar -x -C "$WORKDIR/pub-fs"
docker rm "$PUB_CID" >/dev/null

LOC_CID=$(docker create "oracle:verify-$TAG")
docker export "$LOC_CID" | tar -x -C "$WORKDIR/loc-fs"
docker rm "$LOC_CID" >/dev/null

# --- Step 8: hash every file under /mono and diff ----------------------------

echo
echo "=== Step 8: hash every file under /mono in both filesystems ==="
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
echo "=== Step 9: diff hash manifests ==="
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
  echo "  What this run did NOT verify (see HOW_TO_VERIFY.md Appendix C):"
  if [[ "$ALLOW_UNSIGNED_TAG" == "1" ]]; then
    echo "    - Tag signature: '$TAG' is unsigned (default for v3.11.0)."
  fi
  if [[ -z "$COSIGN_KEY" ]]; then
    echo "    - SLSA provenance signature: COSIGN_KEY not set."
  fi
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

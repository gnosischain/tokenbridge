#!/usr/bin/env bash
#
# verify.sh — reproduce the verification documented in oracle/HOW_TO_VERIFY.md
# end-to-end on the host. No helper container is used: mounting the host
# Docker socket into a container would give that container root-equivalent
# control over the daemon, expanding the trust boundary to every layer of
# its build (Ubuntu image, apt mirrors, Docker's apt repo, this script's
# cloned source). Running on the host keeps the trust boundary tight.
#
# Host requirements:
#   docker (with the buildx plugin), git, jq, tar, sha256sum, sed
#   On non-amd64 hosts (e.g. Apple Silicon), the Docker daemon must be able to
#   run linux/amd64 images via QEMU emulation. Docker Desktop enables this by
#   default; the script checks for it and, if it is missing, it tells you the one
#   command to register it rather than running a privileged container itself.
#
# Usage:
#   ./verify.sh <TAG>                 # verify a published release tag against its source
#
# Optional environment variables:
#   SOURCE_REPO            git remote URL          (default: gnosischain/tokenbridge)
#   IMAGE_REPO             image repository        (default: gnosischain/tokenbridge-oracle)
#   BASE_IMAGE_PKG         purl prefix used to find the base image in SLSA
#                          resolvedDependencies    (default: pkg:docker/node)
#   BASE_IMAGE_FROM_NAME   token to pin in the Dockerfile FROM line
#                                                  (default: node:12)
#   ALLOW_UNSIGNED_TAG     defaults to 1 because release tags may be unsigned
#                          (see oracle/HOW_TO_VERIFY.md, Appendix C, for the limitation
#                          this introduces and the planned fix). Set to 0 to
#                          enforce `git tag -v`; that requires a signed release
#                          plus the maintainer's public key in your GPG keyring.
#
# Exit codes:
#   0   verification passed
#   1   verification failed (filesystem diff under /mono — possible tampering)
#   2   preflight or supply-chain check failed before the build started

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <TAG>" >&2
  echo "  Verify a published release tag against its source (see oracle/HOW_TO_VERIFY.md)." >&2
  exit 2
fi
SOURCE_REPO="${SOURCE_REPO:-https://github.com/gnosischain/tokenbridge.git}"
IMAGE_REPO="${IMAGE_REPO:-gnosischain/tokenbridge-oracle}"
BASE_IMAGE_PKG="${BASE_IMAGE_PKG:-pkg:docker/node}"
BASE_IMAGE_FROM_NAME="${BASE_IMAGE_FROM_NAME:-node:12}"
ALLOW_UNSIGNED_TAG="${ALLOW_UNSIGNED_TAG:-1}"

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

# This script builds and runs linux/amd64 images. On a non-amd64 host (e.g.
# Apple Silicon) that needs the Docker daemon to emulate amd64 via QEMU binfmt.
# Docker Desktop registers this by default; minimal Engine / colima / Rancher /
# arm CI setups may not have it. We don't register it ourselves — that needs a
# privileged container, which would widen this verification's trust boundary,
# against the whole point of running on the host (see header). Instead we probe
# for it and, if it is missing, point the user at their Docker Desktop settings
# and stop.
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

# --- Step 2: verify the release tag is signed --------------------------------

echo
echo "=== Step 2: verify GPG signature on tag $TAG ==="
if git -C "$WORKDIR/src" tag -v "$TAG" 2>&1; then
  echo "Tag signature verified."
else
  if [[ "$ALLOW_UNSIGNED_TAG" == "1" ]]; then
    echo "WARNING: tag '$TAG' is unsigned. Continuing (ALLOW_UNSIGNED_TAG=1, the default)." >&2
    echo "         Without a signature, a force-pushed or retagged release on the" >&2
    echo "         remote could deceive this verification. See oracle/HOW_TO_VERIFY.md" >&2
    echo "         Appendix C for the limitation and the planned move to signed" >&2
    echo "         tags + cosign attestations." >&2
  else
    echo "ERROR: tag '$TAG' is unsigned or its signature could not be verified." >&2
    echo "       Import the maintainer's public key (gpg --recv-keys ...) and re-run," >&2
    echo "       or set ALLOW_UNSIGNED_TAG=1 to accept the limitation documented in" >&2
    echo "       oracle/HOW_TO_VERIFY.md Appendix C." >&2
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

# --- Step 3b: provenance trust caveat ----------------------------------------

echo
echo "NOTE: the provenance read above is trusted as served by the registry; this" >&2
echo "      procedure does not independently authenticate it. A malicious registry" >&2
echo "      could serve self-consistent fake provenance pointing at a fake base" >&2
echo "      image, and the rebuild below would still match against that fake. See" >&2
echo "      oracle/HOW_TO_VERIFY.md Appendix C; signed provenance (Option 3) is the fix." >&2

# --- Step 4: confirm (or pin) the base image in the cloned Dockerfile --------

echo
echo "=== Step 4: confirm (or pin) '$BASE_IMAGE_FROM_NAME' in oracle/Dockerfile ==="
DF="$WORKDIR/src/oracle/Dockerfile"

# oracle/Dockerfile now pins the base by digest (FROM node:12@sha256:...). Two
# cases:
#   - Current tags: the Dockerfile is already pinned. We only *confirm* that pin
#     equals the digest CI recorded in the provenance (Step 3); if they disagree
#     the published image was built from a different base than the committed
#     Dockerfile claims, which is a finding, not a no-op.
#   - Older tags cut before the pin landed: the FROM line is the floating
#     'node:12', and we pin it locally so the rebuild can't drift onto a newer
#     node:12 snapshot. The edit lives only in the throwaway clone.
EXISTING_PIN=""
if pin_line=$(grep -oE "^FROM[[:space:]]+${BASE_IMAGE_FROM_NAME}@sha256:[0-9a-f]{64}" "$DF" | head -1); then
  EXISTING_PIN="${pin_line##*@}"   # -> sha256:<hex>
fi

if [[ -n "$EXISTING_PIN" ]]; then
  # Already pinned — confirm it matches the provenance digest from Step 3.
  if [[ "$EXISTING_PIN" == "sha256:${NODE_DIGEST}" ]]; then
    echo "Dockerfile already pins ${BASE_IMAGE_FROM_NAME}@${EXISTING_PIN} — matches provenance. No edit needed."
  else
    echo "ERROR: base-image mismatch between the Dockerfile and the provenance." >&2
    echo "       oracle/Dockerfile pins:  ${BASE_IMAGE_FROM_NAME}@${EXISTING_PIN}" >&2
    echo "       provenance (Step 3) has: ${BASE_IMAGE_FROM_NAME}@sha256:${NODE_DIGEST}" >&2
    echo "       The published image was built from a different base than the" >&2
    echo "       committed Dockerfile claims. Stop and investigate before trusting it." >&2
    exit 2
  fi
else
  # Floating 'FROM node:12' (older tag) — pin it locally.
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

  # Hard-fail if the pin didn't actually land — a silent no-op would leave the
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
fi

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
  echo "  What this run did NOT verify (see oracle/HOW_TO_VERIFY.md Appendix C):"
  if [[ "$ALLOW_UNSIGNED_TAG" == "1" ]]; then
    echo "    - Tag signature: '$TAG' is unsigned."
  fi
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

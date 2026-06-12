# How to Verify a Published Oracle Image

Three checks, in increasing effort. Run checks 1 **and** 2 on every release —
each takes seconds and they prove different things. Run check 3 when you want
to trust nothing but the source. For the full reasoning, see
[`VERIFICATION_DETAILS.md`](./VERIFICATION_DETAILS.md).

## 1. Digest check

> Checks that the `<VERSION>` tag on Docker Hub still points to the exact
> image CI recorded for this release — i.e. the tag has not been re-pointed
> since publication.

Take `RECORDED_DIGEST` from the GitHub Release body (the `digest:` line under
**Published image**), then compare it to what the registry serves now:

```bash
docker buildx imagetools inspect gnosischain/tokenbridge-oracle:<VERSION> \
  --format '{{.Manifest.Digest}}'
```

Output equals `RECORDED_DIGEST` → pass. Mismatch → the tag was re-pointed;
**stop and investigate.**

## 2. Signature check with cosign (run this too)

> Checks that the image was built and signed by Docker's `github-builder`
> workflow on GitHub Actions — anchored in the public Sigstore transparency
> log — so a forged Release body or a compromised registry cannot fool you.

Requires [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/).
Verify against the digest, not the tag (tags are mutable):

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/docker/github-builder/.github/workflows/build.yml.*$' \
  --certificate-github-workflow-repository gnosischain/tokenbridge \
  gnosischain/tokenbridge-oracle@sha256:<RECORDED_DIGEST>
```

Success prints the verified claims and the signing certificate's identity.
The `--certificate-github-workflow-repository` flag pins the calling repository:
without it, an image built by any repo invoking the same reusable workflow would
also pass.

Note: only releases built by the multi-arch pipeline are signed; older tags (v3.10.0 or less)
fail with "no matching signatures".

## 3. Full audit: rebuild from source (optional, ~10 min)

> Checks that the published image's contents are byte-identical to what the
> source at the release commit builds — without trusting CI at all.

### Inputs you need (obtain from a trusted, out-of-band channel)

- `VERIFIER_SHA` — commit SHA of the audited `verify.sh` to run (the tool).
- `VERSION` — release tag to check, e.g. `v3.11.0` (the subject).
- `EXPECTED_SOURCE_COMMIT` — full 40-character commit SHA `VERSION` must resolve
  to (abbreviated SHAs are rejected).

### Prerequisites

- `docker` (with `buildx`), `git`, `jq`, `tar`, `sha256sum` (or `shasum -a 256`), `sed`.
- ~3 GB free disk; network to Docker Hub and `github.com`.
- Non-amd64 hosts (Apple Silicon): enable `linux/amd64` emulation in Docker Desktop.

### Steps

1. Download the tool, pinned to its commit:

   ```bash
   curl -fsSL \
     https://raw.githubusercontent.com/gnosischain/tokenbridge/<VERIFIER_SHA>/verify.sh \
     -o verify.sh
   ```

2. Run it against the release, asserting the expected source commit:
   ```bash
   bash verify.sh <VERSION> <EXPECTED_SOURCE_COMMIT>
   ```

### Result

- `✅ VERIFICATION PASSED` → image at `<VERSION>` was built from `<EXPECTED_SOURCE_COMMIT>`; files under `/mono` are byte-identical.
- `❌ VERIFICATION FAILED` (exit 1) → differences under `/mono`. Do not deploy; investigate.
- `ERROR: ...` (exit 2) → a preflight or supply-chain check failed before the build —
  e.g. the tag does not resolve to `<EXPECTED_SOURCE_COMMIT>`, or the Dockerfile's
  base pin contradicts the provenance. Stop and investigate.

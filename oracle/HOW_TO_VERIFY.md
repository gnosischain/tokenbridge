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

**Example output for v3.11.1**

```bash
% docker buildx imagetools inspect gnosischain/tokenbridge-oracle:v3.11.1 --format '{{.Manifest.Digest}}'

Name:      docker.io/gnosischain/tokenbridge-oracle:v3.11.1
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:ca55d18213d3ca4c186d9d4076905566ee4e74c62169f7910b83cae400968c2b # <--- Should match this digest

Manifests:
  Name:        docker.io/gnosischain/tokenbridge-oracle:v3.11.1@sha256:0f3a2c4747010b986c190857b9b9a4271ee02a5232bccd3c1375ae15e8d479f7  # <--- arm64 image (referenced by attestation below)
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/arm64

  Name:        docker.io/gnosischain/tokenbridge-oracle:v3.11.1@sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6 # <--- Needed for cosign verify
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    unknown/unknown
  Annotations:
    vnd.docker.reference.digest: sha256:0f3a2c4747010b986c190857b9b9a4271ee02a5232bccd3c1375ae15e8d479f7
    vnd.docker.reference.type:   attestation-manifest

  Name:        docker.io/gnosischain/tokenbridge-oracle:v3.11.1@sha256:d2bb334032d5c5d0a8674aad79070e0dd94a10fd5c7142e7a136c088441665ab # <--- amd64 image (referenced by attestation below)
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/amd64

  Name:        docker.io/gnosischain/tokenbridge-oracle:v3.11.1@sha256:90d79faa22f9ca7943dd867e704973e2afd36b1b8d706fea4408452649c71eb0 # <--- Needed for cosign verify
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    unknown/unknown
  Annotations:
    vnd.docker.reference.digest: sha256:d2bb334032d5c5d0a8674aad79070e0dd94a10fd5c7142e7a136c088441665ab
    vnd.docker.reference.type:   attestation-manifest

```

## 2. Signature check with cosign

> Checks that the image was built and signed by Docker's `github-builder`
> workflow on GitHub Actions — anchored in the public Sigstore transparency
> log — so a forged Release body or a compromised registry cannot fool you.

Requires [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/).
Verify against the digest, not the tag (tags are mutable):

Fetch the attestation manifest hash

**Example for v3.11.1**

1. linux/amd64: `sha256:90d79faa22f9ca7943dd867e704973e2afd36b1b8d706fea4408452649c71eb0`
2. linux/arm64: `sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6`

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/docker/github-builder/.github/workflows/build.yml.*$' \
  --certificate-github-workflow-repository gnosischain/tokenbridge \
  gnosischain/tokenbridge-oracle@sha256:<ATTESTATION_DIGEST>
```

Success prints the verified claims and the signing certificate's identity.
The `--certificate-github-workflow-repository` flag pins the calling repository:
without it, an image built by any repo invoking the same reusable workflow would
also pass.

Note: only releases built by the multi-arch pipeline are signed; older tags (v3.10.0 or less)
fail with "no matching signatures".

**Example output for v3.11.1**

```bash

% cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/docker/github-builder/.github/workflows/build.yml.*$' \
  --certificate-github-workflow-repository gnosischain/tokenbridge gnosischain/tokenbridge-oracle@sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6


Verification for index.docker.io/gnosischain/tokenbridge-oracle@sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - Existence of the claims in the transparency log was verified offline
  - The code-signing certificate was verified using trusted certificate authority certificates

[{"critical":{"identity":{"docker-reference":"index.docker.io/gnosischain/tokenbridge-oracle@sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6"},"image":{"docker-manifest-digest":"sha256:e0d36efecbc63d74d3dad14f2fd09f86f2dd0012f649492cbe8a09b6ef7a45e6"},"type":"https://sigstore.dev/cosign/sign/v1"},"optional":{}}]

```

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

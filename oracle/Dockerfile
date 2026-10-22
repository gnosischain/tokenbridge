# Node 24.22.1 (October 2026 security release), Debian trixie slim.
# Pinned by digest for deterministic, reproducible builds. This is the multi-arch index
# (resolves to linux/amd64 sha256:e79437bb05061f860be420634f676f4394619028df216d4b9361966d7fcc7a14).
# The image ships yarn 1.22.22.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

WORKDIR /mono
COPY package.json .
COPY commons/package.json ./commons/
COPY oracle/package.json ./oracle/
COPY yarn.lock .
# --ignore-scripts: no install scripts and no native (node-gyp) builds, so no compiler or
# apt packages are needed. Every native module in the oracle's dependency tree has a
# pure-JS fallback (keccak, secp256k1, bufferutil, utf-8-validate, and keccakjs -> sha3@1,
# which does not compile on Node 24).
RUN yarn install --frozen-lockfile --production --ignore-engines --ignore-scripts

COPY ./contracts ./contracts
COPY ./commons ./commons
COPY ./oracle ./oracle

WORKDIR /mono/oracle
# Replaces the oracle's skipped postinstall script (scripts/start-worker.sh logs here outside production).
RUN mkdir -p logs
CMD echo "To start a bridge process run:" \
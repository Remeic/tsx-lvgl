FROM espressif/idf:v5.5.5@sha256:a9231d0697ab8f7517cc072e93b7c83e04907bfbfba80b6440d7dbbf90665cf2

ARG TARGETARCH
ARG NODE_VERSION=24.19.0
ARG NPM_VERSION=11.17.0

ENV NODE_HOME=/opt/node
ENV PATH="${NODE_HOME}/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) node_arch="x64"; node_sha="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647" ;; \
      arm64) node_arch="arm64"; node_sha="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" --output "/tmp/${archive}"; \
    echo "${node_sha}  /tmp/${archive}" | sha256sum --check; \
    mkdir -p "${NODE_HOME}"; \
    tar --extract --file "/tmp/${archive}" --strip-components=1 --directory "${NODE_HOME}"; \
    rm "/tmp/${archive}"; \
    npm install --global "npm@${NPM_VERSION}"; \
    npm config set fund false; \
    npm config set audit true

# QEMU is an optional ESP-IDF tool, installed from the pinned IDF tool manifest.
RUN python "${IDF_PATH}/tools/idf_tools.py" install qemu-xtensa qemu-riscv32

WORKDIR /workspace

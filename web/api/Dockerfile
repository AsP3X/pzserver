# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Builder
# -----------------------------------------------------------------------------
FROM rust:1.96-slim-bookworm AS builder

WORKDIR /build

# Dependencies are built against stub sources first, so editing our own code
# does not re-download and recompile the whole tree on every image build.
COPY Cargo.toml Cargo.lock ./
COPY crates/pz-api/Cargo.toml crates/pz-api/Cargo.toml
COPY crates/pz-bridge/Cargo.toml crates/pz-bridge/Cargo.toml
COPY crates/pz-rcon/Cargo.toml crates/pz-rcon/Cargo.toml

RUN mkdir -p crates/pz-api/src crates/pz-bridge/src crates/pz-rcon/src \
    && echo 'fn main() {}' > crates/pz-api/src/main.rs \
    && touch crates/pz-bridge/src/lib.rs crates/pz-rcon/src/lib.rs \
    && cargo build --release --locked \
    && rm -rf crates/pz-api/src crates/pz-bridge/src crates/pz-rcon/src

COPY . .

# Cargo compares mtimes, and the copied sources can look older than the stubs.
RUN touch crates/*/src/*.rs \
    && cargo build --release --locked --bin pz-api

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 pzapi

COPY --from=builder /build/target/release/pz-api /usr/local/bin/pz-api

# The bridge dir is shared with the game container, which runs as its own uid;
# entries there are world-readable (see zomboid:heal-lua-bridge in the PHP stack).
USER pzapi

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/pz-api"]

# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Builder
# -----------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /build

# Lockfile first: dependencies only reinstall when the lockfile itself changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Runtime — unprivileged nginx, which also proxies /api to the Rust service.
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1-alpine AS runtime

COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Not under conf.d/: that whole directory is auto-included into `http`, where
# these would be shadowed all over again. nginx.conf includes it explicitly.
COPY security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

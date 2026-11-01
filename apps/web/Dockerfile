# syntax=docker/dockerfile:1.7
# Sathi web: Angular build served by Nginx (which also reverse-proxies /api and /hangfire).
# Build context = REPO ROOT:  docker build -f apps/web/Dockerfile -t sathi-web .

# ---- 1. build ---------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /src/apps/web
ENV NG_CLI_ANALYTICS=false CI=true
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build -- --configuration production

# ---- 2. runtime -------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# Static app (Angular's browser output) and the infra-owned Nginx config.
COPY --from=build /src/apps/web/dist/web/browser /usr/share/nginx/html
COPY infrastructure/nginx/default.conf /etc/nginx/conf.d/default.conf
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1

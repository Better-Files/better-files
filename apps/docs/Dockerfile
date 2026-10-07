# The Better Files documentation site (apps/docs), built from the repository root: the site imports the
# workspace packages (the home page runs @better-files/core in the browser, and the reference pages are
# generated from the package manifests), so the whole workspace is installed and built first. Railway uses
# this through /railway.json.
#
#   docker build -f apps/docs/Dockerfile -t better-files-docs .
#   docker run -p 3000:3000 better-files-docs
FROM node:24-bookworm-slim

ENV CI=1 NEXT_TELEMETRY_DISABLED=1
# The workspace's pnpm (CI uses the same version).
RUN npm install -g pnpm@12.5.1

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Baked into the static pages at build time. Railway passes service variables and its own
# RAILWAY_PUBLIC_DOMAIN as build arguments; DOCS_SITE_URL wins when set (a custom domain).
ARG DOCS_SITE_URL
ARG RAILWAY_PUBLIC_DOMAIN
ARG NEXT_PUBLIC_DOCS_REPOSITORY_URL=https://github.com/Better-Files/better-files
ARG NEXT_PUBLIC_DOCS_REPOSITORY_BRANCH=main
# Optional: the site's X account on link cards, and search console ownership tokens.
ARG DOCS_X_HANDLE
ARG DOCS_GOOGLE_SITE_VERIFICATION
ARG DOCS_BING_SITE_VERIFICATION
ARG DOCS_YANDEX_VERIFICATION
RUN pnpm --filter @better-files/docs build

ENV NODE_ENV=production
WORKDIR /app/apps/docs
# `next start` listens on $PORT, which Railway injects (3000 when unset).
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

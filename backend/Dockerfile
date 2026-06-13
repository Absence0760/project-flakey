FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
# Patch OS packages to the latest Alpine security releases before anything
# else. The base image is pinned by digest for reproducibility, but that
# digest lags the Alpine mirror, so Trivy flags fixed-but-not-yet-rebased
# CVEs in the bundled openssl libs (libssl3 / libcrypto3 3.5.6-r0 →
# 3.5.7-r0, incl. the HIGH CVE-2026-45447 PKCS7_verify UAF). `apk upgrade`
# pulls the patched packages at build time without unpinning the base.
RUN apk upgrade --no-cache \
 && apk add --no-cache postgresql-client
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
 # Strip the bundled npm CLI from the runtime image. The container
 # only runs `node dist/index.js` after this point — npm itself is
 # never invoked again. Keeping the global npm install ships several
 # CVE-flagged transitive deps (tinyglobby / picomatch /
 # brace-expansion / ip-address) that Trivy picks up on every scan;
 # the vulnerable code paths aren't reachable at runtime but the only
 # way to clear them from the SARIF tab is to remove the files.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p uploads
EXPOSE 3000
CMD ["sh", "entrypoint.sh"]

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
RUN apk add --no-cache postgresql-client
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

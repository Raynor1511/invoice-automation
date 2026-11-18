# The invoice demo service: the static page plus the extraction API (docs/deploy.md).
# Stage 1 builds the page; stage 2 holds only what runs: Node, three dependencies, the code and the samples.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY astro.config.mjs tsconfig.json ./
COPY web ./web
COPY scripts/copy-pdf-fonts.ts ./scripts/
COPY samples/index.json ./samples/
COPY samples/docs ./samples/docs
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/extract ./src/extract
COPY src/data ./src/data
COPY src/server ./src/server
COPY samples/index.json ./samples/
COPY samples/docs ./samples/docs
COPY samples/readings ./samples/readings
COPY --from=build /app/dist/web ./dist/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server/main.ts"]

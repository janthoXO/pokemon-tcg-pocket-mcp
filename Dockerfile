# Multi-stage. Base node:24-slim (glibc), not alpine, so @libsql/client native
# binary for file: mode works without build. Final stage also node:24-slim
# (not distroless): we need a shell for mkdir/chown and a `node` user to drop to.
FROM node:24-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
ENV TRANSPORTS=http HOST=0.0.0.0 PORT=3000 DATABASE_URL=file:/data/cards.db
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker
RUN pnpm --filter shared run build
RUN pnpm --filter worker run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]

FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter shared run build
RUN pnpm --filter api exec prisma generate || true
RUN pnpm --filter api run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/assets ./apps/api/assets
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

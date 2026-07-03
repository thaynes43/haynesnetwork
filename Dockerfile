# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: install all workspace dependencies (frozen).
#   pnpm-workspace.yaml carries the allowBuilds list; embedded-postgres is a
#   test-utils dep (devDependency chain) and never reaches the runtime image.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# Copy lockfile + workspace manifests so the install layer caches well.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: build the Next.js standalone bundle.
# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
# apps/web has no public/ assets yet; standalone output does not create it, so
# make sure the runtime COPY below always has a source directory.
RUN mkdir -p apps/web/public
RUN pnpm --filter web build

# -----------------------------------------------------------------------------
# Stage 3: produce a self-contained migrator subtree (prod deps only).
#   `pnpm deploy` flattens @hnet/db + its prod deps (drizzle-orm, pg) into
#   /migrator-deploy with a real node_modules — no symlinks back into /repo.
# -----------------------------------------------------------------------------
FROM build AS migrator-deploy
WORKDIR /repo
RUN pnpm --filter @hnet/db deploy --legacy --prod /migrator-deploy

# -----------------------------------------------------------------------------
# Stage 4: minimal runtime image.
#   - Runs the Next.js standalone server by default.
#   - The init container in Kubernetes overrides the command to run
#     `tsx /migrator/src/scripts/migrate.ts` against the same image (ADR-006).
#   - tsx is a devDependency of @hnet/db (excluded from the prod deploy), so it
#     is installed globally here; pinned to the lockfile-resolved version.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat curl tini \
  && npm install -g tsx@4.22.5 \
  && npm cache clean --force
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone runtime tree (server + traced workspace node_modules).
COPY --from=build /repo/apps/web/.next/standalone ./
# Static assets (public + .next/static are NOT auto-copied by standalone).
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static

# Migrator subtree (used only by the init container).
COPY --from=migrator-deploy /migrator-deploy /migrator

# Non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app /migrator
USER app

EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/web/server.js"]

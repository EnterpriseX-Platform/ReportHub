# Report Studio Web — Next.js 15 standalone image.
#
# NEXT_PUBLIC_API_BASE is inlined into the client bundle at BUILD time, so it is
# passed as a build-arg (point it at the SIT ingress, e.g. https://<host>/api).

# === deps ===
FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# === build ===
FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Served under https://<host>/reportstudio ; API is same-origin at /reportstudio/api,
# so the client works on any host/IP. (SSR uses API_INTERNAL_BASE at runtime — see the Deployment.)
ARG NEXT_BASE_PATH=/reportstudio
ARG NEXT_PUBLIC_API_BASE=/reportstudio/api
# Build tag: passed via `docker buildx --build-arg BUILD_ID=v1.<date>.<time>`.
# Embedded into the client bundle + served by /version.txt so the in-page guard in
# layout.tsx can detect tabs running an old bundle after a deploy and force-reload.
ARG BUILD_ID
ENV NEXT_BASE_PATH=$NEXT_BASE_PATH
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV BUILD_ID=$BUILD_ID
ENV NEXT_PUBLIC_BUILD_ID=$BUILD_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# === runtime (standalone) ===
FROM node:18-alpine AS runtime
# Re-pass BUILD_ID so /version.txt's route handler reads it from process.env.
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID NEXT_PUBLIC_BUILD_ID=$BUILD_ID
ENV NODE_ENV=production TZ=Asia/Bangkok PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

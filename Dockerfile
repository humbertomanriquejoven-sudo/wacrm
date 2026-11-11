# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Base — shared Alpine + Next.js native deps (libc6-compat).
# ---------------------------------------------------------------
# Node 22 is required by the Google API client packages
# (@googleapis/gmail, @googleapis/calendar, google-auth-library).
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they MUST be present while `next build` runs. Easypanel
# passes the service environment variables as Docker build args, so
# declaring them here is enough — set them in Easypanel's
# "Environment" tab. Changing any of them requires a rebuild.
#
# Server-only secrets (service role key, ENCRYPTION_KEY,
# META_APP_SECRET, ...) are read at runtime and are never baked
# into the image.
# ---------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (Next.js standalone output)
# ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

# Standalone bundle already contains the traced node_modules and
# server.js. Static assets and public/ are copied separately.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public
# i18n dictionaries (safe fallback if dynamic imports are not inlined).
COPY --from=builder --chown=nextjs:nextjs /app/messages ./messages

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok||r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

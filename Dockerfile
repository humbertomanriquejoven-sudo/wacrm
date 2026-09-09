# === base ===
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# === dependencias ===
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# === build ===
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="file:/app/data/agente.db"
RUN npx prisma generate
RUN npm run build

# === migrator: CLI completo para migrate deploy en runtime ===
FROM base AS migrator
WORKDIR /app
RUN npm install prisma@6

# === runtime ===
FROM base AS runtime
WORKDIR /app

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=migrator /app/node_modules/prisma ./node_modules/prisma

COPY --chown=node:node . .

ENV HOSTNAME="0.0.0.0"
ENV PORT="3000"
EXPOSE 3000

USER node

RUN mkdir -p /app/data && chown node:node /app/data

CMD ["sh", "-c", "node /app/node_modules/prisma/build/index.js migrate deploy --schema /app/prisma/schema.prisma && node server.js"]
# auth_svc — also used for the background worker (docker-compose runs `bun workers.ts` with this image)
FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so they are cached between code changes
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

USER bun
EXPOSE 8000
CMD ["bun", "index.ts"]

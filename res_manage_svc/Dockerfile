# res_manage_svc
FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

USER bun
EXPOSE 8002
CMD ["bun", "index.ts"]

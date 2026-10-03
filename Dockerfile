FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY app ./app
COPY lib ./lib
COPY public ./public
COPY next.config.ts tsconfig.json postcss.config.mjs ./

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-noto-cjk \
    python3 \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./

RUN mkdir -p /app/.data && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["sh", "-c", "npx next start --hostname 0.0.0.0 --port ${PORT:-3000}"]

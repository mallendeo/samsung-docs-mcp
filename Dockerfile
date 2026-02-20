FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-alpine AS compress
ARG TARGETARCH
RUN apk add --no-cache upx binutils
# Strip + UPX the musl Bun runtime BEFORE compiling
RUN cp /usr/local/bin/bun /tmp/bun-musl \
    && strip /tmp/bun-musl \
    && upx --best --lzma /tmp/bun-musl

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN BUN_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") \
    && /tmp/bun-musl build --compile --minify \
       --target=bun-linux-${BUN_ARCH}-musl src/server.ts --outfile server

FROM alpine:3.21
RUN apk add --no-cache libstdc++ libgcc ca-certificates
COPY --from=compress /app/server /server
ENV CACHE_DIR=/data
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/server"]

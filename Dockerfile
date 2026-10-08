# Bello – offizielles Playwright-Image mit gepinnter Chromium-Version.
# Die Playwright-Version MUSS zu package.json passen ("playwright": "1.64.0"),
# sonst findet Playwright das vorinstallierte Chromium nicht.
ARG PLAYWRIGHT_VERSION=1.64.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ENV CI=true \
    NO_UPDATE_NOTIFIER=1 \
    BELLO_CACHE_DIR=/config/cache

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY data ./data
COPY LICENSE NOTICE bello.config.example.yaml docker-entrypoint.sh ./
RUN chmod 0755 /app/docker-entrypoint.sh
RUN pnpm build && pnpm prune --prod

# /config: bello.config.yaml + Cache (EasyPrivacy, DB-IP); /reports: Report-Ausgabe
RUN mkdir -p /config/cache /reports && chown -R pwuser:pwuser /config /reports /app
VOLUME ["/config", "/reports"]
WORKDIR /reports
USER pwuser

# Der Entrypoint ergänzt --config /config/bello.config.yaml und --out /reports, sofern nicht angegeben.
# Der Container läuft als uid 1000 (pwuser): Bind-Mounts müssen für uid 1000 beschreibbar sein.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["--help"]

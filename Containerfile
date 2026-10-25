FROM ghcr.io/pnpm/pnpm:12

COPY --from=ghcr.io/ossf/scorecard:latest /ko-app/v5 /usr/local/bin/scorecard

ENV NODE_ENV=production
ENV DB_FILE_NAME=file:/data/predictive-cve.db
ENV BLACKLIST_FILE=/data/blacklist.txt

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
VOLUME ["/data"]

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml drizzle.config.ts ./
RUN pnpm install --frozen-lockfile --prod=true

COPY src ./src
COPY drizzle ./drizzle

ENTRYPOINT ["pnpm", "run", "start"]

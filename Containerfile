FROM ghcr.io/pnpm/pnpm:12

ENV NODE_ENV=production
ENV DB_FILE_NAME=file:/data/predictive-cve.db

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
VOLUME ["/data"]

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml drizzle.config.ts ./
COPY src ./src
RUN pnpm install --frozen-lockfile --prod=true

ENTRYPOINT ["pnpm", "run", "start"]

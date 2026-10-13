# predictive-cve

This repo contains data scraping and model training code for my Data Science distinction project.

Because this scraper runs over a long period of time, a SQLite database is used as a persistent store.

## Run the project

Populate `.env` with `GITHUB_TOKEN` set to a personal access token. Note that this will make the program consume the API rate limits on your account. You don't need to give it any access outside of public GitHub APIs, so no need for personal repository access.

If not running through Docker, the scraper requires the OpenSSF Scorecard binary to be available as `scorecard` on `PATH`. Set `SCORECARD_BINARY` when it is installed at a different path. In addition, set `DB_FILE_NAME` in `.env` to something like `file:local.db`.

If running through Docker, use the pnpm scripts for development:

```sh
pnpm run build:docker
pnpm run dev:docker [COMMAND]
```

To run the container as a production service, use:

```sh
pnpm run start:docker [COMMAND]
```

The service runs detached and restarts unless stopped. Both scripts pass any additional
arguments to the container.

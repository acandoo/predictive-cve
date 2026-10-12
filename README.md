# predictive-cve

This repo contains data scraping and model training code for my Data Science distinction project.

Because this scraper runs over a long period of time, a SQLite database is used as a persistent store.

The scraper requires the OpenSSF Scorecard binary to be available as `scorecard` on `PATH`. Set `SCORECARD_BINARY` when it is installed at a different path.

When running locally (or on a server), populate `.env` with `GITHUB_TOKEN` set to a personal access token, and with `DB_FILE_NAME` set to something like `file:local.db`. Note that this will make the program consume the API rate limits on your account. You don't need to give it any access outside of public GitHub APIs, so no need for personal repository access.

Running it in the server container will automatically set `DB_FILE_NAME` to the persistent database volume. The devcontainer uses a separate development image and mounts the complete workspace, including `.git`, `.github`, `.husky`, `.env`, and `local.db`. It uses the workspace's `local.db`; create or copy that file in the repository if you want to reuse an existing local database. Keep `.env` local and do not add it to either image.

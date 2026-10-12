#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="$repo_root/.env"

if [[ ! -f "$env_file" ]]; then
  printf 'Missing %s\n' "$env_file" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$env_file"
set +a

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  printf 'GITHUB_TOKEN is not set in %s\n' "$env_file" >&2
  exit 1
fi

exec docker run \
  --name predictive-cve \
  --restart unless-stopped \
  --env "GITHUB_TOKEN=$GITHUB_TOKEN" \
  --volume "$repo_root/data:/data" \
  predictive-cve \
  "$@"

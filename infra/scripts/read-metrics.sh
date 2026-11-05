#!/usr/bin/env bash
# Narrative — print the server's GET /metrics (Prometheus text) on the VM.
#
# Usage (on the VM, from /opt/narrative):
#   infra/scripts/read-metrics.sh [CONTAINER]        (default: narrative-server)
#   infra/scripts/read-metrics.sh | infra/scripts/client-metrics.py
#
# The bearer token never appears on a command line. The request is made by
# Node inside the container, which reads METRICS_TOKEN from its own
# environment (docker-compose.prod.yml passes it in). The obvious
# `docker exec … sh -c 'wget --header "Authorization: Bearer $METRICS_TOKEN" …'`
# expands the token into wget's argv, where `ps` and /proc/<pid>/cmdline show
# it to every user of the VM for as long as the request runs.
#
# Exits non-zero (with the HTTP status on stderr) when the token is missing
# from the container, the route is not registered (404, METRICS_TOKEN unset
# in production) or the token is wrong (401). docs/ops.md → Metrics.
set -euo pipefail

CONTAINER="${1:-narrative-server}"

# Single-quoted: nothing here is expanded by this shell; the program reads
# the token from process.env inside the container.
# shellcheck disable=SC2016
exec docker exec "${CONTAINER}" node -e '
const token = process.env.METRICS_TOKEN
if (!token) {
  console.error("METRICS_TOKEN is not set in the container")
  process.exit(2)
}
fetch("http://127.0.0.1:3001/metrics", { headers: { authorization: `Bearer ${token}` } })
  .then(async (res) => {
    if (!res.ok) throw new Error(`GET /metrics answered HTTP ${res.status}`)
    process.stdout.write(await res.text())
  })
  .catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
'

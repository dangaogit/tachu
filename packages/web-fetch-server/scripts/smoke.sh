#!/usr/bin/env bash
# 本地端到端 smoke：fixture HTTP → web-fetch-server → POST /v1/extract（static）。
# @see .cursor/web-fetch-workflow/contracts/s3-i10-server-smoke-check.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_ROOT"

FIXTURE_PID=""
SERVER_PID=""

cleanup() {
  set +e
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null
    wait "${SERVER_PID}" 2>/dev/null
  fi
  if [[ -n "${FIXTURE_PID}" ]]; then
    kill "${FIXTURE_PID}" 2>/dev/null
    wait "${FIXTURE_PID}" 2>/dev/null
  fi
  set -e
}

trap cleanup EXIT

bun run "${SCRIPT_DIR}/smoke.fixture.ts" &
FIXTURE_PID=$!

for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:8788/article" >/dev/null; then
    break
  fi
  sleep 0.05
done
if ! curl -sf "http://127.0.0.1:8788/article" >/dev/null; then
  echo "smoke: fixture server did not become ready on 127.0.0.1:8788" >&2
  exit 1
fi

# WEB_FETCH_ALLOW_LOOPBACK：否则对 127.0.0.1 的上游 URL 会被 SSRF 拒绝（见 0003c 默认 false）。
WEB_FETCH_PORT=8787 \
WEB_FETCH_TOKEN=smoke-local \
WEB_FETCH_ALLOW_LOOPBACK=true \
bun run src/server.ts &
SERVER_PID=$!

for _ in $(seq 1 200); do
  if curl -sf "http://127.0.0.1:8787/healthz" >/dev/null; then
    break
  fi
  sleep 0.05
done
if ! curl -sf "http://127.0.0.1:8787/healthz" >/dev/null; then
  echo "smoke: GET /healthz did not return 200 on 127.0.0.1:8787" >&2
  exit 1
fi

RESP=$(
  curl -sS -f -X POST "http://127.0.0.1:8787/v1/extract" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer smoke-local" \
    -d '{"url":"http://127.0.0.1:8788/article","renderMode":"static"}'
)

# ADR-0003a 成功响应字段为 `body`（契约 §3 文案写为 content，此处按 ADR 校验）。
echo "${RESP}" | bun -e '
const raw = await new Response(Bun.stdin).text();
let j: unknown;
try {
  j = JSON.parse(raw);
} catch {
  console.error("smoke: response is not JSON:", raw.slice(0, 400));
  process.exit(1);
}
const body = (j as { body?: unknown }).body;
if (typeof body !== "string" || body.length < 1) {
  console.error("smoke: expected non-empty JSON string field body, got:", raw.slice(0, 500));
  process.exit(1);
}
'

echo "smoke: ok"

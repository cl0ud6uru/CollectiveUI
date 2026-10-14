#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

export WEB_IMAGE="${WEB_IMAGE:-collectiveui-web:test}"
export WORKER_IMAGE="${WORKER_IMAGE:-collectiveui-worker:test}"
project="collective-web-smoke-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f tests/docker/compose.yml)
cleanup() {
  local result=$?
  if (( result != 0 )); then "${compose[@]}" logs --no-color || true; fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT

"${compose[@]}" up -d --wait --wait-timeout 90 db
"${compose[@]}" run --rm --no-deps worker npm run db:migrate
"${compose[@]}" run --rm --no-deps worker npm run db:migrate
"${compose[@]}" up -d --wait --wait-timeout 120 worker web

for service in worker web; do
  container=$("${compose[@]}" ps -q "$service")
  docker exec "$container" node -e '
    const assert = require("node:assert/strict");
    const { existsSync } = require("node:fs");
    assert.notEqual(process.getuid?.(), 0, "application must run non-root");
    assert.equal(existsSync("/app/.env"), false, "runtime image must not contain an .env file");
    assert.equal(process.env.AUTH_SECRET, "worker-image-smoke-fixture-only");
    assert.equal(process.env.ENCRYPTION_KEY, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_ACCESS_KEY_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET"]) {
      assert.equal(process.env[name], undefined, `${name} must be absent from the smoke runtime`);
    }
  '
done

web_container=$("${compose[@]}" ps -q web)
docker exec "$web_container" node -e '
  const assert = require("node:assert/strict");
  (async () => {
    const health = await fetch("http://127.0.0.1:3000/api/health");
    assert.equal(health.status, 200, "web health endpoint must succeed");
    assert.deepEqual(await health.json(), { ok: true });
    const signIn = await fetch("http://127.0.0.1:3000/login");
    assert.equal(signIn.status, 200, "sign-in page must render");
    const html = await signIn.text();
    assert.match(html.replace(/<[^>]*>/g, ""), /Welcome back/);
    assert.match(html, /Local account|username/i);
    const assetPath = html.match(/\/_next\/static\/[^"\x27<\s]+\.js/)?.[0];
    assert(assetPath, "rendered sign-in page must reference a JavaScript asset");
    const asset = await fetch(new URL(assetPath, "http://127.0.0.1:3000"));
    assert.equal(asset.status, 200, "referenced static asset must be served");
  })().catch(error => { console.error(error); process.exit(1); });
'

# A running process alone is insufficient: database loss must expire/remove worker readiness.
worker_container=$("${compose[@]}" ps -q worker)
"${compose[@]}" stop db
readiness_cleared=false
for attempt in {1..60}; do
  if ! docker exec "$worker_container" node src/worker/healthcheck.mjs; then
    readiness_cleared=true
    break
  fi
  sleep 0.5
done
test "$readiness_cleared" = true

echo "Web/worker image smoke passed: non-root runtimes, synthetic-only auth/encryption, healthy worker and web, database health, and local sign-in page."

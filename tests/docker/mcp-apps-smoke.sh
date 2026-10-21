#!/usr/bin/env bash
# Disposable local/CI containers only. Never reads an installation .env or publishes a port.
set -euo pipefail
cd "$(dirname "$0")/../.."
containers=()
cleanup() { for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
for image in "${SANDBOX_IMAGE:-collectiveui-mcp-app-sandbox:test}" "${WORKER_IMAGE:-collectiveui-worker:test}"; do
  container="$(docker run -d --network none --read-only --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 32 --memory 128m --cpus 0.5 \
    --no-healthcheck -e MCP_APPS_HOST_ORIGIN=https://portal.example.invalid \
    -e MCP_APPS_SANDBOX_HOST=127.0.0.1 -e MCP_APPS_SANDBOX_PORT=3102 \
    "$image" node scripts/mcp-app-sandbox.mjs)"
  containers+=("$container")
  docker exec -i "$container" node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    let response;
    for (let i = 0; i < 30; i++) {
      try { response = await fetch("http://127.0.0.1:3102/sandbox"); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(response?.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp.includes("connect-src 'none'"));
    assert.ok(csp.includes("frame-ancestors https://portal.example.invalid"));
    assert.equal((await fetch("http://127.0.0.1:3102/api/auth/session")).status, 404);
    assert.notEqual(process.getuid(), 0);
    for (const name of ["AUTH_SECRET", "ENCRYPTION_KEY", "DATABASE_URL", "TOOL_APPROVAL_SECRET"]) assert.equal(process.env[name], undefined);
    console.log("Sandbox image command, headers, isolation and non-root runtime verified");
NODE
  # Starting without a parent origin must fail closed in either packaged image.
  if docker run --rm --network none --read-only "$image" node scripts/mcp-app-sandbox.mjs > /dev/null 2>&1; then
    echo 'Sandbox unexpectedly accepted missing parent origin' >&2; exit 1
  fi
done

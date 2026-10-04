# Production worker image validation

The `worker` target installs the lockfile with `npm ci --omit=dev` in its own `runtime-deps` stage. It does not
inherit the build/test dependency layer. Application source, migrations, `tsconfig.json`, and the documented
`scripts/local-account.ts` operator command are included; tests, development servers and repository automation
are not. Application files remain root-owned and readable but not writable by the non-root `app` user.
`/data/uploads` remains writable by `app`.

`tsx` is a **runtime dependency**: both migrations and the worker execute TypeScript source, including `@/`
aliases, with `node --import tsx`. Its locked `esbuild` dependency is retained for that purpose. `drizzle-kit`
is a schema-generation development tool; applying checked-in migrations uses `drizzle-orm` and `pg` instead.
The image retains the application's shared production dependency set (including Next/React and provider SDKs).
This change removes development tooling; it does not claim a fully minimal worker-specific import bundle.

## Build, inventory and audit the shipped install

```bash
docker build --target worker -t collectiveui-worker:test .
docker run --rm collectiveui-worker:test npm ls --omit=dev --all --json > worker-dependencies.json
docker run --rm -e npm_config_cache=/tmp/npm-cache collectiveui-worker:test npm audit --omit=dev --json > worker-audit.json
```

The inventory records installed versions; the audit consults the npm registry and may change as advisories are
published. The smoke test below additionally checks the filesystem against **every dev-only lockfile entry**
and verifies that ESLint, drizzle-kit, Vitest, TypeScript and Playwright cannot be resolved. Reading only the
production portion of a lockfile would not prove that development packages were absent from an image.
These npm reports cover application packages, not Debian packages or the Node image's globally installed npm.
They are not a complete container vulnerability scan.

Issue #2 reported 9 findings (5 high, 4 moderate) in a full development install at the initial public snapshot,
with zero in the production-only audit. Those tooling advisories are not evidence of a production exploit.
Keep auditing the full development install separately; removing it from the worker does not resolve its own
advisories. CI uploads the current worker inventory and audit JSON, and fails on npm audit findings/errors.

## Exercise the actual image

```bash
bash tests/docker/worker-smoke.sh
# To test another local worker build:
WORKER_IMAGE=collectiveui-worker:my-branch bash tests/docker/worker-smoke.sh
```

Docker Compose creates a uniquely named, disposable PostgreSQL/pgvector database and the repository's mock LLM.
It ignores the checkout's `.env`, uses public synthetic fixture secrets, publishes no host ports, and places all
services on an internal network without Internet egress. The script destroys its containers, network and database
on exit, including failures. It never targets an existing installation or calls a paid provider.

The check applies migrations twice through `npm run db:migrate`, starts the image's default command (migrate then
worker), and queues a real non-admin user's reply through pg-boss. It checks successful execution, saved assistant
text, usage attribution, non-root execution, application-file permissions, writable storage, and omitted development
dependencies. It then stops the worker and requires a clean exit. The assertion script and mock server are mounted
read-only only into fixture containers; the worker under test has no extra source or dependency mounts.

This smoke test covers one OpenAI-compatible mock reply, not every provider, browser flow, sandbox, live Hermes
installation or upgrade from every historical schema. Use the dedicated suites for those behaviors. Unit tests
belong in the separate [Docker test target](../development.md#running-the-tests).

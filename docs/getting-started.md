# Local development setup

[Back to the overview](../README.md) · [Deployment and backups](operations.md)

Start with the [local-account quickstart in the README](../README.md#try-it-locally). It needs no enterprise directory or paid model account. This guide adds the optional LDAP fixture, development tools and troubleshooting.

## Optional LDAP demo and E2E stack

Use Node.js 22.18+ and Docker Compose. This optional directory fixture is for LDAP development and the general E2E suite. For a first look without LDAP, use the local-account walkthrough above. The demo directory credentials below are public test fixtures: never expose this stack or reuse them in production.

```bash
npm ci
docker compose -f docker-compose.dev.yml up -d   # Postgres+pgvector, seeded OpenLDAP, mock LLM
cp .env.example .env.local                       # then set the values below
node --env-file=.env.local --import tsx src/db/migrate.ts
npm run db:seed                                  # adds a "Mock GPT" app, a demo group and bot
npm run dev                                      # http://localhost:3000
npm run worker:dev                               # in a second terminal: chat replies, routines, memory (required)
```

Minimal `.env.local` for the dev stack: run `openssl rand -base64 32` three times and replace the three secret placeholders with separate outputs. Do not paste the placeholders themselves.

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/portal
AUTH_URL=http://localhost:3000
AUTH_SECRET=REPLACE_WITH_FIRST_GENERATED_SECRET
ENCRYPTION_KEY=REPLACE_WITH_SECOND_GENERATED_SECRET
TOOL_APPROVAL_SECRET=REPLACE_WITH_THIRD_GENERATED_SECRET
AUTH_LOCAL_ENABLED=false
AUTH_ENTRA_ENABLED=false
LDAP_ENABLED=true
LDAP_URL=ldap://localhost:389
LDAP_BIND_DN=cn=admin,dc=corp,dc=local
LDAP_BIND_PASSWORD=adminpw
LDAP_BASE_DN=ou=people,dc=corp,dc=local
LDAP_GROUP_BASE_DN=ou=groups,dc=corp,dc=local
LDAP_USER_FILTER=(&(objectClass=inetOrgPerson)(|(uid={{username}})(mail={{username}})))
LDAP_UPN_SUFFIX=corp.local
LDAP_GROUP_MODE=member
ADMIN_GROUPS=cn=ai admins,ou=groups,dc=corp,dc=local
```

Sign in as `alice` (admin), `bob` (Engineering) or `carol` (no groups). The password for all three is `Passw0rd!`. Run `npm run db:seed` once after the first sign-in to also create the demo bot.

The mock LLM (`dev/mock-llm`) streams replies and supports scripted tool calls. Type `[tool:web_search {"query":"x"}]`, `demo`, or `delegate <task>` to exercise tools, rendering and delegation without a real model. `npm run mcp-echo` starts a sample MCP server at `http://localhost:4020/mcp` (also in `docker-compose.dev.yml`) with the tools `echo`, `get_time`, `lookup_employee`, `whoami`, `long_text` and a destructive `delete_record`. Set `MCP_TOKEN` to require a static bearer key and `MCP_IDENTITY_SECRET` (plus optionally `MCP_IDENTITY_AUDIENCE` and `MCP_REQUIRE_IDENTITY=true`) to verify the portal's signed per-user identity header; `/__mock/tools` switches its tool list to exercise change review.

## Troubleshooting

- **Port already in use:** the demo expects Postgres on 5432, the model on 4010 and the web app on 3000. Stop the conflicting development service, or adjust its published port and the corresponding environment value. `MOCK_LLM_URL` controls the seed's model URL when creating its connection; edit an existing connection in Admin if it was already seeded.
- **Database connection fails:** wait for `docker compose -f docker-compose.dev.yml exec db pg_isready -U postgres` to report ready. The explicit `node --env-file` migration command uses your chosen database; `npm run db:migrate` alone requires `DATABASE_URL` to be exported already.
- **No bot after seeding:** bootstrap or sign in first, then run `npm run db:seed` again. A bot needs an owner account.
- **Reply never arrives:** keep both the web app and worker running with the same database and secrets; check their terminal logs and the mock model service. A missing worker eventually produces a pickup error.
- **Bootstrap says already initialized:** sign in with the existing account. Use [operator recovery](operations.md#password-reset-and-operator-recovery) if needed; do not delete the bootstrap marker or reset an existing database.
- **Changing sign-in providers:** restart the web app after changing authentication settings. Local-only setup should have Entra and LDAP disabled.

Stop the web app and worker with Ctrl-C. `docker compose -f docker-compose.dev.yml stop` stops the demo dependencies while retaining data. Do not add `-v` to a Compose teardown when you want to keep the database.

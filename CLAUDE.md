@AGENTS.md

# Project notes (AI Portal)

- Next.js 16 App Router + AI SDK v7 (`ai`, `@ai-sdk/react`, `@ai-sdk/openai-compatible`, `@ai-sdk/mcp`). Read the bundled
  docs in `node_modules/next/dist/docs` and `node_modules/ai/docs` before changing framework-level code — APIs differ
  from older versions (`proxy.ts` not middleware, `instructions` not `system`, `isStepCount`, `toolApproval`, `onEnd`).
- Auth: `src/auth.ts` (Auth.js v5, local accounts + Entra + LDAP credentials). Every server entry point must authorize through
  `src/lib/session.ts` + `src/lib/authz.ts`; never trust client-sent tool parts (see `src/lib/agent/approval-merge.ts`).
- Native/Hermes direct and background turns: `src/lib/agent/run.ts` (`runTurn`). Tools live in `src/lib/agent/tools`,
  assembled per bot in `toolset.ts`; approval policy is the pure `approvals.ts`. Group turns use `group.ts`; the Codex text pilot uses `src/lib/codex/` through the durable executor.
- Worker: `src/worker/index.ts` (pg-boss). Schema: `src/db/schema.ts` → `npm run db:generate` → `npm run db:migrate`.
- Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` (needs the dev stack, see README).
- Attribution: never add `Co-Authored-By`, `Claude-Session`, "Generated with Claude Code", session links or any other
  Claude/AI attribution to commits, branches, PRs, issues or comments. Everything should read as written by the repo owner.

# Bot chat header regression

The header suite uses original synthetic catalog artwork generated in `tests/e2e/chat-header.spec.ts`.

## Reproduction

Use a disposable PostgreSQL database named `collective_header_test` on
`127.0.0.1`, migrate it with `npm run db:migrate`, and install the project's
dependencies. Start the development app at `http://localhost:3120`, the worker,
and `dev/mock-llm/server.mjs` on port 4020. Use synthetic secrets, local auth
enabled, Entra/LDAP disabled, and the same database/secrets for app and worker.
Do not use a production database or real model provider.

Export that fixture configuration, then run:

```sh
CHAT_HEADER_BROWSER=1 PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
  npx playwright test -c tests/chat-header.playwright.config.ts
```

The suite creates synthetic accounts and messages and writes test screenshots to the Playwright output directory.

The five browser scenarios cover themes, 320–1920 px widths, open/collapsed side
panels, empty and short chats, long scrolling, first/last-message reachability,
wheel and link hit-testing under the fade, keyboard focus clearance, menus and
dialogs, long names, pet variants and sizing, activity/approval state, font-size
changes, and reduced motion. Browser coverage used Chromium; Firefox and Safari
were not run.

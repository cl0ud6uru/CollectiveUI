# Native workspace gateway acceptance

This proof runs the pinned Hermes dashboard's real ASGI application, WebSocket
upgrade and `tui_gateway.ws.handle_ws`, real RPC dispatch/contract registry,
profile owner wrapper, session lifecycle, native SQLite stores, and installed
workspace methods. Portal operations use the production GET/POST route handlers,
principal lookup, PostgreSQL ownership/receipts, transport policy and WebSocket
client. Auth.js request identity and the dashboard auth provider are synthetic;
the Next HTTP server/middleware and interactive login are not launched.

The source is archived from clean Hermes
`f97608f178d1ffeca59860195ab7da295f7c8e5f`. Installers compose recovery, workspace
registration and ownership only inside the disposable archive. No installer is
applied to the original checkout or a live profile. The native fixture clears
inherited environment, uses temporary profiles/configuration, blocks external
socket/DNS destinations and subprocess network commands, and uses synthetic agent
construction without invoking a model turn. Each case asserts zero agent turns
and zero external network attempts. These are fixture guards, not an OS sandbox.

The portal database must be a newly migrated, disposable `hermes_fixture` on
`127.0.0.1` with an explicit port. URL connection options and PostgreSQL driver
environment overrides are rejected before importing database-backed modules.
The suite has its own opt-in flag and skips without it.

```sh
DATABASE_URL='postgres://fixture:synthetic-password@127.0.0.1:55439/hermes_fixture' \
HERMES_SOURCE=/path/to/clean/hermes-at-the-pin \
HERMES_DASHBOARD_PYTHON=/path/to/isolated/python \
REMOTE_HERMES_WORKSPACE_GATEWAY=1 \
  npm test -- --project integration \
  tests/integration/remote-hermes-workspace-gateway.test.ts \
  --maxWorkers=1 --configLoader runner --cache=false
```

Run from the composed read branch with
`REMOTE_HERMES_WORKSPACE_GATEWAY_ADAPTER=read` for #264. Run from the composed
write branch without that option for #281. Both read the current checkout's
tracked adapter, so a shallow checkout does not need another branch's Git
objects. The native fixture reports SHA256 digests for the actual workspace
module, owner module and owner installer; the test compares those with its input
files and logs the digests.

## Results on 2026-10-21

The integration branches compose the published #284 stack and owner-core repair
`398096de08920bca0b86787c4e9d81b3c41ff5d0` with the respective workspace PR.
The disposable local database was PostgreSQL 16.14 with pgvector 0.8.1.

- #264 read adapter plus repair `7fbd842b37bdb6b6a12e4fdc810c9225a573eea7`:
  four gateway cases passed; the two write cases intentionally skipped.
- #281 write adapter plus repair `c8472318f30a7d3c7672d52f2237607bb41f8ed0`:
  six gateway cases passed.
- Both cover profile A → B → A reads, protected-path rejection, anonymous and
  foreign portal actors, profile/workspace mismatch, actual native busy rejection
  4090, an unclaimed authenticated socket, and stale-owner rejection 4091.
- Write coverage adds explicit prepare/confirm, origin checks, altered-content
  rejection, confirmations bound to their saved chat, stale digest rejection,
  native replacement/readback, durable receipts and duplicate confirmation
  without replay. Every case leaves model-turn and external-attempt counters at
  zero. Gateway temporary directories are removed; the local runner stopped its
  temporary PostgreSQL server after each run.

| Input | SHA256 |
| --- | --- |
| #264 workspace module | `f4fd2a86eed38f5f2128fef10155df709cb3e2d4696ebb5c3c2f38bd1df636be` |
| #281 workspace module | `154c8f2e2391dcaad75620f0ca0588ecabdbb4f596bc62affbe339bd3efdd047` |
| Owner module from 398096d | `4eb647defefd2f2f14a8a7cbcb253fd2e46c8535589b495215e05e33b6c837e3` |
| Owner installer from 398096d | `1f8cf68dd284e3f58369e73966f6b35a77312a08a100fabe8f062ba764d563fc` |

## Reproduced defects

Before the registration repair, the real gateway failed during startup because
the adapter read nonexistent `rpc_dispatch._LONG_HANDLERS`. The pinned dispatcher
is rebound to the server namespace; adding methods to `server._LONG_HANDLERS`
is sufficient. The older composed harness fabricated the source-module attribute
and therefore missed this failure. Its regression now starts without that
attribute and inspects the dispatch function's actual globals.

After repairing startup, the real operations handler rejected saved portal chat
IDs with HTTP 400: its schema required UUIDs while `openNativeSession()` creates
16-character IDs through `newId()`. The bounded nonempty ID schema now matches
the other native session endpoints and retains the exact owner/connection lookup.
The unit regression uses the production ID generator.

This closes the tested gateway registration/operations boundary. It does not
establish a live server's extension/version compatibility, production incident
root cause, same-device mount isolation, or general filesystem compare-and-swap
against unrelated external writers. The documented filesystem boundaries remain.

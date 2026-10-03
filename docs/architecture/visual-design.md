# Visual design

The portal mixes two references: **ChatGPT desktop** for model chats and the overall chrome, and **Grok Bot** /
**ChatGPT dots** for bots (persistent teammates with an avatar, a status and their own computer).

## Tokens (`src/app/globals.css`)

- Neutral ink and greys everywhere. `--accent` is ink (black in light, near-white in dark) with `--accent-fg`; there is no
  brand hue. Colour means something: bot avatars, and the status tokens `--working` (purple, busy), `--warn` (amber,
  needs you), `--success` (green), `--danger` (red).
- Dark mode is its own palette (`#181818` page, `#111111` sidebar), not an inversion. `--hover` is translucent so it
  reads on every surface; menus use `--popover`, dialogs `--dialog`. Never hard-code `dark:bg-[#…]`.
- Inter is bundled with `next/font/local` (no font CDN), so every OS renders the same.

## Chats (`components/chat/message.tsx`)

- `variant="plain"` (apps/models): grey user bubble, assistant as full-width Markdown.
- `variant="bubbles"` (bots and groups): the bot's text in `--bubble-bot` bubbles (chatty paragraphs split, rich answers
  stay whole), your messages in the bot's colour from `bubbleTint()` (every pair passes WCAG AA, see the unit test),
  group speakers named above their run with the avatar beside it.
- Consecutive tool steps fold into one "Worked for 35s ›" row (`steps.tsx`); a step that needs approval always stays
  visible. Failures are a small count, not a red banner. Timing comes from `startedAt`/`finishedAt` message metadata.
- Centred timestamps appear before the first message and after gaps of 30 minutes or more.

## Bots

- Avatars are flat blobs with two eyes (`bot-avatar.tsx`); the portal mark is the same shape in ink. Motion shows state
  instead of typing dots: `idle` blinks, `thinking` glances, `working` bobs, `waiting` leans. Reduced motion stops it.
- The sidebar roster keeps its stable order; each row adds the home chat's latest line, a short time and a status dot
  (`lib/chat/roster.ts`). Status is per conversation: each open chat reports only itself (`setChatStatus`) and the row
  shows the most urgent of those and the server's, so an idle home never hides a side chat waiting for approval.
- Status pulses use `motion-safe:`; avatar motion stops under reduced motion too.
- The bot panel is flat: who it is, its workspace "screen" (latest command in your own workspace, only for bots with
  workspace tools), then only the sections that have something, then routines.

## Pages and controls

- `PageFrame` gives every page one left-aligned `h1` and an optional description. Profile pages (bot details,
  templates) keep a centred avatar hero instead.
- Use `components/ui/select` (native `<select>` API, Radix underneath) rather than a bare `<select>`; e2e tests pick
  options with `choose()` from `tests/e2e/helpers.ts`.

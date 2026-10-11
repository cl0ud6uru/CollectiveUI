# Fullscreen voice

Voice is another way to use the current direct chat. Select the headphones button in the chat header, then **Start voice**. The fullscreen view includes a 3D avatar, microphone mute, captions, **Minimize**, and **End voice**. Minimizing keeps the call running and lets you type or review tool approval cards. Navigation away closes the local microphone and makes a best-effort save/close request. Use HTTPS or localhost.

Native Collective bots and Hermes bots keep their existing backend model, durable conversation, memory, tools, and permissions. GPT-Live handles speech and delegates substantive requests to that backend. Speech is saved to the same message tree; the backend answer and the spoken version can both appear. Restarting voice restores recent history from the selected branch. Group and delegated read-only chats are excluded.

## Configuration

In **Admin → Bots & tools → Voice & avatar**, select an existing company OpenAI API connection with access to `gpt-live-1` and, for reactions, the Decisions API (`gpt-6-luna`). Each user must also have access to that transport connection. This lets a Hermes or non-OpenAI bot retain its own backend. Without an explicit voice connection, an eligible OpenAI chat uses its own connection. Personal ChatGPT plan credentials and custom/proxy endpoints cannot provide the voice transport.

Voice duration, Decisions calls, and the bot's existing backend have their own billing. The selected OpenAI API key remains on the server; the browser receives the WebRTC answer and session ID. Voice does not consume a ChatGPT/Codex subscription allowance for the OpenAI transport. Reactions can be disabled independently.

## Blender model

Until a model is ready, the stage displays an animated procedural placeholder. To replace it:

1. Export **glTF 2.0 → GLB** from Blender with textures embedded and animation enabled.
2. Save it under `public/avatars`, for example `public/avatars/nimbus.glb`.
3. Set the avatar path to `/avatars/nimbus.glb` in Voice & avatar settings.

The renderer centers and scales the model. Optional animation clip names are `idle`, `nod`, `curious`, `smile`, and `concerned` (case insensitive). Optional mesh morph targets `mouthOpen` or `jawOpen` respond to output audio amplitude. This is an amplitude-driven mouth, not phoneme-accurate lip sync. The placeholder remains available when model loading fails. Models and external resources must be hosted under `/avatars/` on the same origin. The initial setting is shared across bots; per-bot model selection can follow when character assets are ready.

## Conversation and reactions

- WebRTC carries GPT-Live audio. The browser consumes `session.input_transcript.delta` and `session.output_transcript.delta`, preserving speaker and session timestamps. Transcript arrival alone never starts a bot tool request.
- `session.delegation.created` triggers a short transcript settling window. The authenticated `/api/voice/turn` route saves the relevant speech and calls the existing `startRun` path. Native and Hermes workers execute the usual bot workflow. Stable batch/reply identities prevent a retry from starting duplicate work.
- The bridge polls the admitted run and returns its result through Live context/commentary events. Tool approvals open the normal chat cards. Spoken “yes” never submits an approval.
- Transcript writes serialize with normal run admission. A running bot keeps its current message leaf; speech waiting to be saved is retained in the browser, and the interface exposes **Retry save**. Do not leave the chat with an unsaved-transcript notice. Network loss or closing the tab before saving can lose buffered speech; backend tasks already admitted remain durable.
- In parallel, `/api/voice/reaction` sends a short rolling transcript and current gesture to Decisions, choosing only `keep_current`, `neutral`, `nod`, `curious`, `smile`, or `concerned`. Requests are coalesced, have a 900 ms provider deadline, and fall back to the current pose. Stale/low-confidence decisions are discarded. Gesture changes have a minimum dwell time. Blinking, breathing, smoothing, and mouth movement run locally and honor reduced-motion preferences.
- Server budgets cap session starts and reaction calls per user across replicas. Transcripts and backend output are not written to diagnostic logs.

The application separates speech, bot work, and animation; a slow Decisions call cannot delay audio. Actual spoken-word-to-motion latency still includes transcription and network time and must be measured with a live account. Current automated coverage uses synthetic provider events and an in-process PostgreSQL fixture; it does not establish real OpenAI latency or validate a particular Blender rig.

## Validation

- `npm run typecheck`
- `npx vitest run --project unit voice`
- `node tests/browser/voice-mode.mjs` (Playwright Chromium; optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `VOICE_SCREENSHOT_DIR`)

Official references: [Live session/transcript events](https://developers.openai.com/api/docs/guides/live-conversations), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [Decisions](https://developers.openai.com/api/docs/guides/decisions), and [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc).


## Native iOS 27 client

The iOS app exposes the same voice session, turn, reaction, and approval behavior through authenticated `/api/mobile/v1/voice/[operation]` routes. SwiftUI owns the fullscreen screen, controls and microphone activity visualization. Transcripts remain in chat, with no transcript display in fullscreen voice. A bundled SwiftUI WebView engine reuses `VoiceBridge` and `VoiceAvatar`, including the server-configured GLB and Decisions gestures; API requests pass through a narrow native URLSession bridge. Credentials are never passed into JavaScript. See `ios/README.md` for regeneration, model limits, preview and device testing.

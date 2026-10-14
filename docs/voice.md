# Fullscreen voice

Voice is another way to use the current direct chat. Select the headphones button in the chat header, then **Start voice**. The fullscreen view includes the current pet or bot icon (or a configured 3D avatar), microphone mute, captions, **Minimize**, and **End voice**. Minimizing keeps the call running and lets you type or review tool approval cards. Navigation away closes the local microphone and makes a best-effort save/close request. Use HTTPS or localhost.

Native Collective bots and Hermes bots keep their existing backend model, durable conversation, memory, tools, and permissions. GPT-Live handles speech and delegates substantive requests to that backend. Speech is saved to the same message tree; the backend answer and the spoken version can both appear. Restarting voice restores recent history from the selected branch. Group, delegated read-only and Hermes Team chats are excluded.

## Configuration

In **Admin → Bots & tools → Voice & avatar**, select an existing company OpenAI API connection with access to `gpt-live-1` and, for reactions, the Decisions API (`gpt-6-luna`). Each user must also have access to that transport connection. This lets a Hermes or non-OpenAI bot retain its own backend. Without an explicit voice connection, an eligible OpenAI chat uses its own connection. Personal ChatGPT plan credentials and custom/proxy endpoints cannot provide the voice transport.

Voice duration, Decisions calls, and the bot's existing backend have their own billing. The selected OpenAI API key remains on the server; the browser receives the WebRTC answer and session ID. Voice does not consume a ChatGPT/Codex subscription allowance for the OpenAI transport. Reactions can be disabled independently.

## Blender model

Without a configured 3D model, the stage uses the current chat's effective pet or saved bot icon. See [stock 2D avatars](voice-2d-avatars.md) for their gestures and fallback behavior. To use a custom 3D model:

1. Export **glTF 2.0 → GLB** from Blender with textures embedded and animation enabled.
2. Save it under `public/avatars`, for example `public/avatars/nimbus.glb`.
3. Set the avatar path to `/avatars/nimbus.glb` in Voice & avatar settings.

The renderer centers and scales the model, preserves its materials, and uses soft lighting with ACES tone mapping so subtle facial changes remain visible. Rigs with a named `head` bone use closer bust framing for facial readability; unknown models retain full-model framing. Models and external resources must be hosted under `/avatars/` on the same origin. A procedural 3D placeholder appears while a configured model loads or if it fails to load. The initial setting is shared across bots; per-bot model selection can follow when character assets are ready.

All rig capabilities are optional and discovered once when the GLB loads. Current clients use the [reaction library](voice-reaction-library.md): six facial recipes and ten procedural head/posture patterns with independent state. A compatible `head` or `neck` bone supports gestures, and `chest` supports posture. The authored `idle` clip loops beneath these layers; exported nod/expression clips are used only by the legacy reaction controller.

| Capability | GLB names | Behavior |
| --- | --- | --- |
| Attentive idle | `idle` clip | Loops beneath procedural gesture layers (or legacy reaction clips). |
| Legacy acknowledgment | `nod` clip | Legacy controller only: plays once, then fades back to idle. |
| Legacy body expressions | `curious`, `smile`, `concerned` clips | Legacy controller only: blend over idle and hold their final pose. Frame zero is the neutral reference; export body channels independently of facial morphs. |
| Concerned face | `browInnerUp` and `mouthFrown` morphs | Smoothly raise the inner brow and lower lip corners. `mouthFrownLeft`/`Right` are also supported. |
| Positive face | `mouthSmile` morph | Smooth lip-corner smile; `mouthSmileLeft`/`Right` are also supported. |
| Complete expressions | `expressionConcerned`, `expressionSmile`, `expressionCurious` morphs | Optional alternatives to individual facial channels. |
| Output mouth | `mouthOpen` or `jawOpen` morph | Smoothed audio amplitude, independent of facial expression; not phoneme-accurate lip sync. |
| Local blink | `eyeBlink` or `eyeBlinkLeft`/`Right` morphs | Optional periodic blink. |

Names ignore case (morph names also ignore separators); facial morphs use a neutral weight of zero and a range of 0–1. The renderer blends modest expression weights, releases them on `neutral`, and keeps an expression during a nod. Missing morphs remain absent: a head tilt is listening motion, not a frown. The Borg asset contract is `browInnerUp`, `mouthFrown`, and `mouthSmile`; its fused textured eyes and lips do not imply jaw or blink support. No model asset is included by the reaction implementation.

A named `head` bone inside the model bounds enables a closer view. Full-body rigs retain that framing. For a head-heavy skinned bust, neutral vertices predominantly weighted to the head define its focus and visible extent; the camera fits that extent in both axes, including depth and a motion margin, and updates on canvas resize. These bounds are measured once at load. Unknown rigs retain their full-model view.

See [session/task lifecycle](voice-lifecycle.md) for fresh/resumed calls, transcript settling, corrections, and verified result delivery. [Local audio diagnostics](voice-audio-diagnostics.md) describes opt-in capture for the next device round.

## Conversation and reactions

- WebRTC carries GPT-Live audio. The browser consumes `session.input_transcript.delta` and `session.output_transcript.delta`, preserving speaker and session timestamps. Transcript arrival alone never starts a bot tool request.
- `session.delegation.created` triggers a short transcript settling window. The authenticated `/api/voice/turn` route saves the relevant speech and calls the existing `startRun` path. Native and Hermes workers execute the usual bot workflow. Stable batch/reply identities prevent a retry from starting duplicate work.
- The bridge polls the admitted run and returns its result through Live context/commentary events. Tool approvals open the normal chat cards. Spoken “yes” never submits an approval.
- Transcript writes serialize with normal run admission. A running bot keeps its current message leaf; speech waiting to be saved is retained in the browser, and the interface exposes **Retry save**. Do not leave the chat with an unsaved-transcript notice. Network loss or closing the tab before saving can lose buffered speech; backend tasks already admitted remain durable.
- In parallel, the client bridge reconstructs utterances from tiny STT deltas, preserves each speaker's timeline, and sends the latest partial utterance context to `/api/voice/reaction` for Decisions. Explicit sadness or loss can choose `concerned` before an assistant speaking turn; negation, corrections, and quoted speech remain contextual evidence. Current clients request version 1 of the reaction library, with independent face, motion, intensity and pace choices. Older clients retain `keep_current`, `neutral`, `nod`, `curious`, `smile`, and `concerned`. Reactions never authorize external actions.
- Reaction requests coalesce at 450 ms, have a 900 ms provider deadline and a 1400 ms client deadline, and fall back to the current pose. Freshness follows the utterance and bounded text progress rather than delta count, permitting continuous partial speech while dropping interrupted/old stories, stale replies, invalid choices, and confidence below 0.65. Changes have a 900 ms dwell; a valid change arriving during that window is deferred and rechecked. Repeated facial states do not restart gestures; an explicit motion replay is separately limited by its cooldown.
- Facial expressions hold until context changes; they do not automatically reset after three seconds. Rendering is capped at 30 frames per second and pauses when minimized or hidden. For 3D models, Reduce Motion suppresses body movement and blinking while retaining a slowly blended contextual face and optional audio mouth. The 2D renderer shows a neutral still and releases its output analyser. Transcript handling, bot work, and speech remain independent of rendering.
- Server budgets cap session starts and reaction calls per user across replicas. Transcripts and backend output are not written to diagnostic logs.

The application separates speech, bot work, and animation; a slow Decisions call cannot delay audio. Actual spoken-word-to-motion latency still includes transcription and network time and must be measured with a live account. Current automated coverage uses synthetic provider events and an in-process PostgreSQL fixture; it does not establish real OpenAI latency or validate a particular Blender rig.

## Validation

- `npm run typecheck`
- `npx vitest run --project unit voice`
- `node tests/browser/voice-mode.mjs` (Playwright Chromium; optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `VOICE_SCREENSHOT_DIR`)
- `node tests/browser/voice-avatar.mjs` (synthetic GLB, mid-story face, hold/release, reduced motion, missing capabilities/assets, minimize/resume; optionally set `VOICE_AVATAR_MODEL_PATH` for a local exported rig and `VOICE_AVATAR_SCREENSHOT_DIR` for private captures)

Official references: [Live session/transcript events](https://developers.openai.com/api/docs/guides/live-conversations), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [Decisions](https://developers.openai.com/api/docs/guides/decisions), and [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc).


## Native iOS 27 client

The iOS app exposes the same voice session, turn and reaction behavior through authenticated `/api/mobile/v1/voice/[operation]` routes. Approval decisions use the normal chat controls and routes. SwiftUI owns the fullscreen screen, controls and microphone activity visualization. Transcripts remain in chat, with no transcript display in fullscreen voice. A bundled SwiftUI WebView engine reuses `VoiceBridge` and `VoiceAvatar`, including the server-configured GLB and Decisions gestures; API requests pass through a narrow native URLSession bridge. Credentials are never passed into JavaScript. See [the iOS README](../ios/README.md) for regeneration, model limits, preview and device testing.

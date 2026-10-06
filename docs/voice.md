# Live voice sessions

1. In Admin → Apps, configure an OpenAI API connection with a Responses model and a saved project API key that has access to `gpt-live-1`.
2. Open a direct chat using that app or an associated bot, select the headphones button, then **Start voice**. Allow microphone access. Use HTTPS or localhost.
3. Use **Mute** to pause microphone input and **End** to finish. If audio playback is blocked, use the audio controls. Closing the panel keeps the conversation running.

Voice transcripts are temporary and do not become text-chat messages. Existing chat history, attachments, memory, and app tools are not connected to the voice session. Voice duration and the delegated Responses model incur separate OpenAI API charges; they do not use a ChatGPT/Codex subscription allowance. End unused sessions to stop duration billing.

The chat API offers a Live voice session for direct conversations backed by an OpenAI API app with company credentials. The session uses `gpt-live-1` for the live audio transport and delegates recognized speech to the app's configured Responses model. The app's saved OpenAI credential stays on the server; the browser receives only the session id and WebRTC answer SDP.

Voice is available only when the resolved provider connection points to `https://api.openai.com/v1`. OpenAI-compatible proxies, ChatGPT plan credentials, other vendors, group chats, and delegated conversations are unsupported. The Responses delegation receives the app and bot instructions with no tools enabled, so it cannot perform actions available to a regular chat turn. A Live model cannot be selected as the delegation model; configure a Responses API model on the app.

The authenticated `GET /api/voice/session` endpoint accepts one of `appId`, `botId`, or `conversationId` and reports `{ supported, reason? }`. `POST /api/voice/session` accepts the same target plus an SDP offer, and returns `{ session: { id }, transport: { type: "webrtc", sdp } }` after OpenAI accepts it. Requests must be same-origin when an Origin header is present, and the JSON body is limited to 64 KB.

The browser waits for `session.started`, reads input/output transcript deltas, and sends `session.close` before releasing the connection. Ending waits up to 15 seconds for `session.closed`; a timeout means final usage could not be confirmed. Navigation releases local microphone tracks and makes a best-effort close request.

Implementation references: [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [session lifecycle and transcripts](https://developers.openai.com/api/docs/guides/live-conversations), [Responses delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [GPT-Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1).

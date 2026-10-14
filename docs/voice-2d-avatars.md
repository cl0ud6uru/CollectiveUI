# Stock 2D voice avatars

When no global 3D model is configured, voice uses the current chat's effective pet or saved bot icon. Configured 3D models keep their existing renderer and priority. Missing or malformed atlases fall back to the same bot's icon. No preference, icon, catalog asset or model is rewritten.

Web reads the effective identity from the existing PetProvider and chat target. Native reads the same target and authenticated shell. APIClient loads only PetAppearance's validated, bot-bound avatar path; a bounded canonical PNG is passed to the embedded engine as image bytes. Credentials and server URLs stay native. Revision changes cancel older loads. The engine accepts no arbitrary image URL through its native identity hook.

## Actual capabilities

The four bundled pets use the standard v2 atlas: 192 × 208 cells, eight columns, eleven rows. The adapter uses the real idle row (0), wave row (3), review row (8), and screen-left/right direction cells (row 10/9, column 4). Warm/reassuring intents can play one wave. Curious/sympathetic/serious intents share the authored review sequence. These are context cues, not distinct authored emotions. v1 atlases have nine rows and use gentle whole-body orientation instead of the absent direction cells.

The seven existing colored blob shapes, Moss/Ember vectors and saved emoji icons keep their artwork. Shared ReactionPlan intensity, tempo and duration drive bounded whole-body nod, tilt, orientation and lean gestures. Positive, curious and thoughtful reactions remain visually modest. Every gesture returns to neutral; motionRevision controls replay independently of reactionRevision.

Sprites supply their existing idle frames, including any blink already drawn there. No extra blink, emotion or speaking-mouth frames are inferred or generated. Output amplitude produces at most a 2.5% body pulse. It indicates output activity and does not claim phoneme lip-sync. There is no 3D conversion or synthesized icon replacement.

## Lifecycle and parity

The renderer updates image crops and a single DOM transform at most 30 times per second, without React frame renders or WebGL. Reduce Motion, the personal still preference, stopped voice, minimized surfaces and document hiding show the neutral still and suspend frame work. Hidden/stopped/reduced surfaces release the optional output-only analyser. Unmount disconnects the analyser, closes its context and cancels callbacks. No microphone is opened by the avatar. Native forwards its accessibility Reduce Motion setting explicitly.

Web and the bundled native engine share the same pose and frame selection code. Native uses the standard PNG atlas, while the regular chat's separate renderer may offer an HD rendition. The 3D bone/morph diagnostic report does not represent 2D capabilities. Live provider timing and physical-device performance remain unverified; QA uses mocked voice/reactions and the offline native demo.

## Reproduce offline QA

```
node ios/scripts/build-voice-engine.mjs --check
node scripts/voice-sprite-preview.mjs --port 4321
SPRITE_PREVIEW_OUTPUT=/tmp/sprite-qa node tests/browser/voice-sprite-icons.mjs
node tests/browser/voice-mode.mjs
node tests/browser/voice-avatar.mjs
npx vitest run --project unit tests/unit/voice-avatar-2d.test.ts
```

The preview binds to loopback and serves existing repository artwork. The browser suite rejects external requests and fails if its native fixture requests a microphone or backend. It covers four sprites, two vectors, seven blob shapes, a robot icon, v1, missing and malformed assets, speaking, repeated/cancelled gestures, still/Reduce Motion, hidden/stopped suspension and the exact generated native HTML. Native VoiceAvatarIdentityTests check atlas byte/dimension limits; existing VoiceSessionTests cover continuity and saved-session lifecycle.

The adapter uses the shared [reaction library](voice-reaction-library.md). After changing shared avatar, reaction, or native engine sources, regenerate `voice-engine.html` with `node ios/scripts/build-voice-engine.mjs` and verify it with `--check`.

# Voice reaction library

The shared web/iOS avatar supports 60 named combinations: six facial recipes and ten head/posture patterns. These are parameterized reactions, not 60 distinct facial shapes or authored animation clips. The verified Borg v3 works with the new controller; richer validated morphs can be added without blocking voice audio.

## Local preview

Run from the checkout:

```sh
node scripts/voice-reaction-preview.mjs --model /absolute/path/borg-hermes-bust-expressive-v3.glb
```

Open `http://127.0.0.1:4317`. Without `--model`, load a local GLB under Model capabilities. Use the library selector, face/motion buttons, Replay, Stop, Showcase, and intensity/tempo/duration controls. No microphone, credentials, provider calls or bot actions are used. This dev server binds only localhost and is not a production route. Assets are not committed by this workflow.

Faces: attentive, warm, sympathetic, curious, reassuring, thoughtful. Motions: listening, small nod, slow nod, double nod, left/right tilt, left/right head glance, lean in/back. All 60 combinations are named in `src/lib/voice/reaction-library.ts`. Glances rotate the head; they do not claim eye gaze. Unsupported facial channels are omitted and listed in the preview.

## Layer behavior

Face, head gesture and posture/idle have independent state. A facial change does not replay a completed nod. Timed gestures ease back to attentive listening; the face holds throughout a story until a newer contextual decision changes it. Quiet quasi-periodic idle variation supplements the authored idle without per-frame random jitter or unsolicited repeated nods. Local gestures use anatomical world axes mapped to each bone's neutral parent basis and remove their previous offsets before each update.

Intensity is clamped to 0.35–1, tempo to 0.7–1.35, and gesture duration to 1.2–6 seconds. At full intensity procedural nod pitch is at most 12 degrees, tilt 10 degrees, turn 15 degrees, and lean 5 degrees, plus small idle offsets. The supplied idle clip may add its own authored motion. No arm/hand or hair simulation is implied. Frame submission remains capped at 30Hz and pixel ratio at 1.75. Hidden surfaces suspend drawing independently of voice audio. Reduce Motion stops body/head and repetitive blink motion while allowing a gently changing static face and optional audio mouth. A gesture received with movement disabled is not replayed on resume.

The placeholder has its own head/chest bones and retains listening motion when a custom model is absent or fails to load. Models without compatible bones retain supported facial morphs without invented facial expressions from whole-model rotation.

## Versioned Decisions protocol

The existing authorized OpenAI Decisions adapter is used, with four `choice` questions: face, motion, intensity and pace. No simulated Decisions result is used in production. `libraryVersion: 1` opts into the new plan; requests from older clients retain the original six-choice protocol. The chosen face maps to the legacy reaction label for compatibility. A separate motion revision controls replay.

`keep_current` is represented by explicit preserve flags. The bridge rebases preserved channels against its current state when a result is applied, including after dwell; it does not overwrite a newer face with the request's old snapshot. Pulse cooldown suppresses a repeated motion independently from a fresh facial response. Replay waits at least three seconds and until the prior duration/tempo plus 350ms has elapsed.

Existing limits remain: one in-flight request; at least 450ms between starts; 900ms provider deadline; 1,400ms total client deadline; confidence at least 0.65; 900ms gesture-change dwell; 150 requests/minute/user. Freshness still requires the same utterance/speaker, prefix-compatible text, at most 160 appended characters, and age at most 1,400ms. Only new transcript evidence schedules requests. Face/motion are validated independently; uncertain intensity/pace retains the previous value. Failures preserve the current state. No reaction authorizes tools, permissions or external actions. Actual provider/transcript-to-motion latency remains unmeasured by the offline preview.

## Asset contract

- Bones: `root`, `chest`, `neck`, `head`; retain neutral rest transforms. Supported motion layers use `chest`, `head`, or `neck` fallback.
- Morphs: weights 0–1, neutral all zero. Baseline `mouthSmile`, `mouthFrown`, `browInnerUp`. Supported unilateral alternatives `mouthSmileLeft/Right`, `mouthFrownLeft/Right`, `browInnerUpLeft/Right`. A complete unilateral pair replaces the combined shape to prevent duplicate deformation.
- Optional controls: `browOuterUpLeft/Right`, `browDownLeft/Right`, `mouthPucker`, `mouthPressLeft/Right`, `mouthStretchLeft/Right`, `cheekSquintLeft/Right`, `noseSneerLeft/Right`, `eyeWideLeft/Right`, `eyeSquintLeft/Right`, `eyeBlink` or `eyeBlinkLeft/Right`, `jawOpen` or `mouthOpen`. Names are matched without punctuation/case differences. Optional controls are discovered; several are reserved for future recipes and do not imply all are animated today.
- Complete-expression alternatives `expressionSmile/Concerned/Curious` remain profile-specific and suppress overlapping primitive weights.
- Authored `idle` is optional, loops independently, and must contain no facial weight channels. The rich controller uses procedural gestures rather than replacing their timing with asset clips. Existing legacy clip support remains for `idle/nod/curious/smile/concerned`; extra authored clips are not advertised as active rich-library controls.
- Every body clip starts at t=0 with neutral/reference transforms; no facial animation channels. Validate each facial target and combined recipe on the actual texture/materials before advertising it.

Verified v3 has only the three baseline facial morphs and no jaw/open-mouth or blink. Its fused textured face cannot supply credible gaze, phoneme/viseme lip sync or eyelid closure without asset work. Optional future mouth motion is RMS-driven opening, not phoneme lip sync. Preserve the character's likeness and report unavailable geometry honestly.

## Local diagnostics and native QA

Web Avatar diagnostics is off by default. Native debug inspection exposes `window.voice.reactions.start()/stop()/report()`. Captures last at most three minutes, retain 128 numeric/enum event samples and one current motion snapshot, and stop on session finish/disposal. Records include accepted/stale/confidence/invalid/unchanged/timeout/deferred/cooldown counts, request-to-application time, effective gesture time, render submission CPU time, supported controls and application-to-first-motion-frame delay. That last delay is null when not measured. GPU completion and spoken-word-to-transcript latency are not inferred.

`window.voice.preview.load(base64GLB)` and `.play(presetId)` are guarded by an active offline demo session; both reject live sessions. They allow private simulator fixtures to load the actual GLB via Blob without network or microphone. Fixture assets are kept outside Git. No audio transport, sample-rate or buffer changes are part of this work; audio-click diagnosis is deferred.

Browser validation: `REACTION_PREVIEW_URL=http://127.0.0.1:4317 REACTION_PREVIEW_OUTPUT=/tmp/reaction-qa node tests/browser/voice-reaction-library.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only if an existing Chrome installation is required. Focused unit suites cover all plans, first/repeated gestures, independent face changes, delayed preserve rebasing, pulse cooldown boundaries, slow/double duration, cancellation, rotated parent axes, missing/combined/unilateral morphs, Reduce Motion, session reset tokens and diagnostic bounds.

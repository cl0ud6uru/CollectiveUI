# Local voice audio diagnostics

The cause of the reported iPhone clicks is still unconfirmed. These diagnostics observe the current WebRTC/HTMLAudioElement path without changing its routing, buffers, sample rates, microphone constraints, or avatar appearance.

Capture defaults off. During an existing voice session, expand **Audio diagnostics** and choose **Capture locally**. **Stop capture** retains the report; **Clear** stops and erases it; **Export JSON** saves a local file. Starting a new capture clears the preceding report. Capture stops after three minutes or 180 samples, with at most 32 timing events and eight audio stats objects per sample. Nothing is saved to storage or sent to a server automatically. Ending voice stops collection; discarding the native session clears its report.

The report contains numeric metrics and fixed enum labels only. It excludes raw audio, transcripts, prompts, credentials, SDP, ICE addresses, stream/session IDs, asset URLs, device names, port names, and port UIDs. The native bridge validates the allowlist again before export. The collector never creates, resumes, suspends, or closes an AudioContext.

## Interpretation

- `elapsedMs` is relative to capture start, not a wall-clock timestamp.
- Inbound counters are interval deltas. The first sample, replaced streams, reset counters, and unsupported fields omit the corresponding delta. `packetsLostDelta` may be negative when the browser revises packet loss. `jitterMs` is the maximum across observed audio streams. `meanJitterBufferMs` is the change in summed buffer delay divided by the change in emitted samples, in milliseconds.
- Optional `media-playout` counters describe locally synthesized playout samples and delay. These are not implemented by every browser. Their absence does not establish that playback is healthy. Stats failures/timeouts produce `stats: unavailable`; absence of a peer produces `no-peer`. Failed reads never export error strings. Stats reads time out after 750 ms and never overlap within a capture.
- Context state, sample rate, and available latency estimates are read from the existing input/output analysis contexts. They do not measure the HTMLAudioElement's actual hardware buffer.
- `renderer` aggregates rendered-frame gaps and JavaScript/render submission work each sampling interval. Gaps above 50 ms are counted. `meanWorkMs`/`maxWorkMs` do not measure GPU completion or audio underruns. Minimization suspends frame work but leaves the audio analysis contexts alive.
- `avatar-fetch` measures the native asset reply; `avatar-decode` covers synchronous base64/byte/Blob work; `avatar-load` covers GLTFLoader loading and parsing. If capture starts after loading, those events are absent.
- Native route metrics read AVAudioSession without activating or configuring it. Native and browser samples are taken sequentially and are not sample-accurate. Category/mode/port codes below describe the current session, not proof of the source of a click.

| Codes, starting at 1 (`0` = other) | Order |
| --- | --- |
| `categoryCode` | playAndRecord, playback, record, ambient, soloAmbient, multiRoute |
| `modeCode` | voiceChat, videoChat, default, measurement, gameChat, spokenAudio, moviePlayback, videoRecording, voicePrompt |
| `inputPortCodes` / `outputPortCodes` | builtInMic, builtInSpeaker, builtInReceiver, headphones, headsetMic, bluetoothHFP, bluetoothA2DP, bluetoothLE, airPlay, usbAudio, lineIn, lineOut, HDMI, carAudio |

A useful comparison keeps speaker volume and the ongoing reply constant: mute/unmute the microphone, then expand/minimize. Rising discard/concealment with clicks suggests reception/decode timing trouble, but does not by itself prove the network caused it. A repeatable expanded/minimized difference with stable reception metrics supports further renderer investigation. A separately controlled analysis-context comparison would be needed to isolate Web Audio interaction. No such comparison or physical-device reproduction has been performed by this change.

## Session integration

The shared web/native session code connects these hooks to one collector per voice surface. Capture starts only from the diagnostic controls; it never starts from the voice start path. The snippets document the integration contract.

### `ios/VoiceEngine/index.tsx`

Import `VoiceAudioDiagnostics` from `../../src/lib/voice/audio-diagnostics`. After the peer/audio/input declarations, instantiate:

```ts
const audioDiagnostics = new VoiceAudioDiagnostics({ peer: () => pc, audio: () => audio });
```

Pass `diagnostics={audioDiagnostics}` to VoiceAvatar in `render()`. Immediately after creating `inputAudio` in `monitorInput`, call `audioDiagnostics.setContext("input", inputAudio)`. In `release()`, call `audioDiagnostics.stop()` and `audioDiagnostics.setContext("input", null)` before closing the existing context. In `end()`, stop diagnostics after the existing immediate mute/pause/physical track-stop statements; do not add any awaited diagnostic operation ahead of microphone shutdown.

Add this property to `window.voice`:

```ts
diagnostics: {
  start: () => audioDiagnostics.start(false), // Native provides the one-second clock.
  sample: () => audioDiagnostics.sample(),
  stop: () => audioDiagnostics.stop(),
  clear: () => audioDiagnostics.clear(),
  report: () => audioDiagnostics.report(),
},
```

Around the existing avatar request and base64 decode, insert timings without changing the request/decode/order:

```ts
const avatarFetchTiming = audioDiagnostics.beginTiming();
// existing voiceAPI.postMessage(...).then(result => {
// existing abort/status guard first
audioDiagnostics.endTiming("avatar-fetch", avatarFetchTiming);
const avatarDecodeTiming = audioDiagnostics.beginTiming();
// existing Uint8Array.from(atob(...)), revoke old URL, and create Blob URL
audioDiagnostics.endTiming("avatar-decode", avatarDecodeTiming);
// existing render()
```

### `ios/CollectiveUI/Voice/VoiceSessionModel.swift`

Add `let audioDiagnostics = VoiceAudioDiagnostics()` as a stable observed child. After creating `page` and setting the handler's model in `init`, connect a weak closure:

```swift
audioDiagnostics.connect { [weak self] operation in
    guard let self else { return nil }
    return try await self.page.callJavaScript(
        "return await window.voice.diagnostics[operation]()",
        arguments: ["operation": operation])
}
```

In `end()`, **after** the existing native microphone shutdown and `pauseAllMediaPlayback`, call `await audioDiagnostics.stop()` while the page is still available. In the valid `dismiss()` disposal branch, call `audioDiagnostics.disconnect()` before `page.stopLoading()`. The latter is synchronous and cancels capture without delaying page disposal. Apply the same disconnect when a lifecycle fix discards/replaces the model without using `dismiss()`.

### `ios/CollectiveUI/Voice/VoiceModeView.swift`

Insert `VoiceAudioDiagnosticsView(diagnostics: model.audioDiagnostics, active: model.status == "connected")` in the scrollable content. Keep the child mounted with the voice surface when minimized. Its active-state hook stops capture when disconnected; the model end/disposal hooks still own cleanup if the view disappears.

### `src/components/chat/voice-control.tsx`

Import `VoiceAudioDiagnostics` and `VoiceAudioDiagnosticsControls`. After the resource and audio refs, create the stable collector:

```tsx
const [audioDiagnostics] = useState(() => new VoiceAudioDiagnostics({
  peer: () => null,
  audio: () => null,
}));
useEffect(() => {
  audioDiagnostics.setSources({ peer: () => resources.current?.pc ?? null, audio: () => audioRef.current });
  return () => audioDiagnostics.dispose();
}, [audioDiagnostics]);
```

Pass `diagnostics={audioDiagnostics}` to VoiceAvatar. Place `<VoiceAudioDiagnosticsControls diagnostics={audioDiagnostics} active={status === "connected"} />` in the voice dialog's scrollable content. This is the only web start control. In `end()`, stop diagnostics after the existing immediate microphone mute and playback pause. Stop it in current-session cleanup, including failures and aborted startup. Avoid letting a stale resource's cleanup stop a newer session's capture. Include the collector in changed hook dependency lists.

Finally regenerate `ios/CollectiveUI/Voice/Resources/voice-engine.html` once from the combined sources with `node ios/scripts/build-voice-engine.mjs`, then run its `--check`. The checked-in resource includes the combined lifecycle and diagnostics sources.

## Offline verification

```sh
node_modules/.bin/vitest run --configLoader native --project unit tests/unit/voice-audio-diagnostics.test.ts --maxWorkers=1
npm run typecheck
node_modules/.bin/eslint src/lib/voice/audio-diagnostics.ts src/components/chat/voice-audio-diagnostics.tsx src/components/chat/voice-avatar.tsx tests/unit/voice-audio-diagnostics.test.ts

xcrun swiftc -module-cache-path /tmp/collectiveui-audio-swift-module-cache \
  ios/CollectiveUI/Voice/VoiceAudioDiagnosticStore.swift \
  ios/DiagnosticsTests/VoiceAudioDiagnosticStoreFixture.swift \
  -o /tmp/collectiveui-audio-diagnostic-store-fixture
/tmp/collectiveui-audio-diagnostic-store-fixture

xcrun swiftc -module-cache-path /tmp/collectiveui-audio-swift-module-cache \
  ios/CollectiveUI/Voice/VoiceAudioDiagnosticStore.swift ios/CollectiveUI/Voice/VoiceAudioDiagnostics.swift \
  ios/DiagnosticsTests/VoiceAudioDiagnosticsLifecycleFixture.swift \
  -o /tmp/collectiveui-audio-diagnostic-lifecycle-fixture
/tmp/collectiveui-audio-diagnostic-lifecycle-fixture
```

The native store fixture executes the production allowlist. The lifecycle fixture executes the production controller/store with only the platform route reader stubbed. Neither opens an audio device, app, microphone, or provider connection. The unsigned simulator build verifies the actual AVAudioSession reader and SwiftUI export view compile. Integrated web control/bridge wiring is exercised by `tests/browser/voice-mode.mjs` with mocked media and synthetic stats. Actual iPhone playback still requires the next authorized device round.

# Local voice audio diagnostics

The cause of the reported iPhone clicks is still unconfirmed. These diagnostics observe the current WebRTC/HTMLAudioElement path without changing its routing, buffers, sample rates, microphone constraints, or avatar appearance.

Capture defaults off. During an existing voice session, expand **Audio diagnostics** and choose **Capture locally**. **Stop capture** retains the report; **Clear** stops and erases it; **Export JSON** saves a local file. Starting a new capture clears the preceding report. Capture stops after three minutes or 180 samples, with at most 32 timing events and eight audio stats objects per sample. Nothing is saved to storage or sent to a server automatically. Ending voice stops collection; discarding the native session clears its report.

The report contains numeric metrics and fixed enum labels only. It excludes raw audio, transcripts, prompts, credentials, SDP, ICE addresses, stream/session IDs, asset URLs, device names, port names, and port UIDs. The native bridge validates the allowlist again before export. The collector never creates, resumes, suspends, or closes an AudioContext.

## Interpretation

- `elapsedMs` is relative to capture start, not a wall-clock timestamp.
- Inbound counters are interval deltas. The first sample, replaced streams, reset counters, and unsupported fields omit the corresponding delta. `packetsLostDelta` may be negative when the browser revises packet loss. `jitterMs` is the maximum across observed audio streams. `meanJitterBufferMs` is the change in summed buffer delay divided by the change in emitted samples, in milliseconds.
- Optional `media-playout` counters describe locally synthesized playout samples and delay. These are not implemented by every browser. Their absence does not establish that playback is healthy. Stats failures/timeouts produce `stats: unavailable`; absence of a peer produces `no-peer`. Failed reads never export error strings. Stats reads time out after 750 ms and never overlap within a capture.
- Context state, sample rate, and available latency estimates are read from the existing input/output analysis contexts. They do not measure the HTMLAudioElement's actual hardware buffer.
- `renderer` aggregates rendered-frame gaps and JavaScript/render submission work each sampling interval. Gaps above 50 ms are counted. `meanWorkMs`/`maxWorkMs` do not measure GPU completion or audio underruns. Minimization suspends frame work. The 3D renderer keeps its analysis context alive until disposal; the 2D renderer releases its output analyser when hidden, stopped or reduced. The 2D renderer currently does not report renderer/output-context metrics to this collector.
- `avatar-fetch` measures the native asset reply; `avatar-decode` covers synchronous base64/byte/Blob work; `avatar-load` covers GLTFLoader loading and parsing. If capture starts after loading, those events are absent.
- Native route metrics read AVAudioSession without activating or configuring it. Native and browser samples are taken sequentially and are not sample-accurate. Category/mode/port codes below describe the current session, not proof of the source of a click.

| Codes, starting at 1 (`0` = other) | Order |
| --- | --- |
| `categoryCode` | playAndRecord, playback, record, ambient, soloAmbient, multiRoute |
| `modeCode` | voiceChat, videoChat, default, measurement, gameChat, spokenAudio, moviePlayback, videoRecording, voicePrompt |
| `inputPortCodes` / `outputPortCodes` | builtInMic, builtInSpeaker, builtInReceiver, headphones, headsetMic, bluetoothHFP, bluetoothA2DP, bluetoothLE, airPlay, usbAudio, lineIn, lineOut, HDMI, carAudio |

A useful comparison keeps speaker volume and the ongoing reply constant: mute/unmute the microphone, then expand/minimize. Rising discard/concealment with clicks suggests reception/decode timing trouble, but does not by itself prove the network caused it. A repeatable expanded/minimized difference with stable reception metrics supports further renderer investigation. A separately controlled analysis-context comparison would be needed to isolate Web Audio interaction. No such comparison or physical-device reproduction has been performed by this change.

## Session integration

The hooks are implemented in the shared web/native session code, with one collector per voice surface. Capture starts only from the diagnostic controls, never from the voice start path.

- `ios/VoiceEngine/index.tsx` owns the browser collector, passes it to `VoiceAvatar`, registers the input context, and exposes `window.voice.diagnostics.start/sample/stop/clear/report`. Native capture supplies the one-second sampling clock. Asset fetch and decode are timed without changing their order. Release stops diagnostics before closing the existing input context.
- `ios/CollectiveUI/Voice/VoiceSessionModel.swift` owns a stable `VoiceAudioDiagnostics` child and connects it to the bundled page through a weak closure. End shuts down microphone capture and pauses playback before stopping diagnostics. Disposal disconnects capture before stopping the page.
- `ios/CollectiveUI/Voice/VoiceModeView.swift` keeps `VoiceAudioDiagnosticsView` in the scrollable voice surface. Its active-state hook stops capture on disconnect; the session model also owns cleanup.
- `src/components/chat/voice-control.tsx` owns the web collector, connects the current peer/audio sources, passes diagnostics to the avatar and renders the capture controls. End and current-session cleanup stop capture; stale resource cleanup cannot stop a newer session's capture.

After changing these sources, regenerate `ios/CollectiveUI/Voice/Resources/voice-engine.html` with `node ios/scripts/build-voice-engine.mjs`, then run `node ios/scripts/build-voice-engine.mjs --check`.

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

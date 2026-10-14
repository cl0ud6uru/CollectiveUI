> Historical design QA records follow. They describe the checks performed for their original changes, not a fresh certification of every current screen. Local `/home/...` references are operator evidence paths and are not distributed in this repository. Workspace browser captures were refreshed on 2026-10-12 with the current component fixture; the original comparison images were not regenerated. See [the documentation audit](docs/reviews/documentation-audit.md).

# Workspace browser design QA

**Findings**

No actionable P0/P1/P2 findings remain. This is an adaptation of the reference's right-hand workspace/tabs/file-tree pattern into CollectiveUI, rather than a copy of the Codex desktop shell.

## Visual evidence

- Source visual truth: `/home/jhartley/.codex/attachments/8509f0e0-91eb-4e79-81d3-4a6d52d887b0/codex-clipboard-d3ed82eb-29d9-47f9-b854-5d3c17c3b101.png`, 2558 × 1410 raster pixels. User instructions in the chat determine the scope; screenshot conversation text is not treated as instructions.
- Same-viewport empty state: `docs/screenshots/workspace-browser/reference-viewport-empty.png`, 2558 × 1410 CSS/pixel dimensions, DPR 1.
- Full comparison: `/home/jhartley/.codex/visualizations/2026/10/07/01a117f0-436e-7202-b173-2bf5e1804dbd/workspace-browser/full-comparison.png`. Source on the left, implementation on the right, each uniformly scaled to 1279 × 705. The source's underlying OS density is unknown; no CSS-density assumption is made about it.
- Focused tabs/tree comparison: `/home/jhartley/.codex/visualizations/2026/10/07/01a117f0-436e-7202-b173-2bf5e1804dbd/workspace-browser/focused-comparison.png`. Header, view controls and file tree regions are compared at readable scale; proportions differ intentionally for the 600px default app panel.
- Working desktop states: `docs/screenshots/workspace-browser/desktop-empty.png`, `desktop-files.png`, `desktop-terminal.png`, `desktop-light.png`, each 1600 × 1000 CSS/pixels, DPR 1.
- Mobile: `docs/screenshots/workspace-browser/mobile-320.png` and `mobile-390.png`, 320/390 × 844 CSS/pixels, DPR 1.

Source/comparison images remain local; the user's original screenshot is not copied into repository assets.

## Required surface checks

- **Typography:** uses CollectiveUI's established sans-serif text and system monospace for file/terminal content. Preview and command text is 12px; small metadata is 11px. Long filenames truncate with full-path titles; code scrolls horizontally without expanding the page. Heading weights distinguish workspace, file navigation and empty states.
- **Spacing/layout:** persistent right panel, 56px desktop header, separate Files/Terminal controls, document tab strip and right-edge 190px explorer preserve the reference pattern. The panel starts at 600px, can resize between 420 and 900px, and is capped at 58vw. On narrow screens an accessible dialog stacks the bounded explorer above the preview so download/chat/terminal controls remain visible.
- **Colors/tokens:** existing `--bg`, `--sidebar`, `--border`, `--fg`, `--muted`, `--working`, and `--success` tokens are used. Neutral light/dark surfaces match the application rather than the reference's OS tint. Active document tabs use a restrained purple underline; selection has a separate surface state.
- **Assets/icons:** existing Lucide stroke icons match the application's controls. No fabricated raster assets, custom icon drawings, or screenshot-as-UI substitutions. The source includes no required artwork for this feature.
- **Copy/content:** distinguishes the owner's shared workspace from a bot's chat, explains text/binary preview limits, loaded-file filtering, upload preservation and explicit Run behavior. The runner is not represented as an interactive persistent terminal.

## Comparison history

1. Initial render: [P2] file/terminal content at 11px was too dense for an everyday browser. Increased to 12px and metadata to 11px; recaptured desktop, light mode, and mobile states.
2. Keyboard pass: [P2] tablists lacked arrow-key navigation. Added arrow/Home/End selection and a single selected tab in the tab order. Browser assertions pass.
3. Final full/focused comparison: no remaining actionable P0/P1/P2 findings. The existing app palette, narrower default panel, upload empty-state CTA, and stacked mobile file tree are intentional adaptations.

## Functional verification

Actual component browser checks cover expanded directory navigation, loaded-entry filter/reset, document switching, inert HTML previews, binary download state, original file download, uploads, preserving a message draft while inserting a path, bot output, direct command streaming, Stop cancelling the stream, keyboard resizing, arrow-key view tabs, close/reopen, 1100/1366px layouts, and 320/390px mobile controls. Light and dark states captured. No browser page errors. A separate existing artifact test checks safe SVG downloads on desktop/mobile.

Backend unit tests cover ownership and input boundaries. Two tests also passed through the actual route handlers against Devlinux's gVisor service using a random temporary workspace, with synthetic authentication and no model calls. The temporary workspace was removed.

**Open Questions / test limits**

Browser fixtures use synthetic chat/API data. Real LDAP login, a paid-model conversation, and delegated bot approvals are not tested by this fixture. These tests do not claim a deployed release. The browser's main command, upload and preview backend behavior is independently checked against the live daemon.

**Implementation Checklist**

1. Use owner-authorized sandbox helpers for every data operation: complete.
2. Preserve chat/composer and approval behavior: complete.
3. Verify primary desktop/mobile interactions and compare captured states: complete.
4. Pass targeted tests, lint and production build: complete.

**Follow-up Polish**

No blocking polish items. Rich image/PDF/table previews and a persistent interactive PTY are outside this implementation.

final result: passed

---

# iOS 27 fullscreen voice — 2026-10-10

**Findings**

No actionable P0/P1/P2 findings remain for the implemented native adaptation. The user's later instructions require iOS 27 only and a microphone visualization instead of an on-screen transcript. These intentionally override the earlier web screenshot's captions and caption control.

## Evidence and comparison

- Source visual truth: `docs/screenshots/ios-voice/web-reference.png`, 390 × 844 pixels, web CSS viewport 390 × 844 at DPR 1, connected voice state with the shared 3D avatar.
- Native implementation: `docs/screenshots/ios-voice/voice-fullscreen.png`, 1206 × 2622 pixels, 402 × 874 logical points at 3×. The offline preview exercises the rendered engine and native controls; it explicitly says “Preview · mic off.”
- Full comparison: `docs/screenshots/ios-voice/comparison.png`. Both images are uniformly normalized to 390 pixels wide and placed in one comparison image; native height is 848 pixels, source height 844. Native OS status/home regions remain visible. Platform chrome, bot fixture name, microphone-off preview status, system typography, and the requested transcript-to-waveform change are intentional differences. This is an adaptation, not a claim of pixel-identical viewports or a live provider capture.
- Focused control comparison: `docs/screenshots/ios-voice/controls-comparison.png`, bottom 260 pixels of each normalized screen. Native mute and End voice have distinct labels and sufficiently large targets; the caption display and caption button are absent.
- Additional rendered evidence: `voice-resumed.png`, `voice-back-to-chat.png`, `voice-large-text.png`, `voice-landscape.png`, and `voice-ipad.png` in the same directory. iPad capture is 2064 × 2752 pixels, 1032 × 1376 points at 2×. Largest accessibility text uses a scrolling stage and pinned controls; decorative avatar content can move out of view while text and actions take priority.

## Required fidelity surfaces

- **Fonts and typography:** native system fonts, title/body hierarchy, Dynamic Type, full wrapped bot name and status. Control labels remain accessible at the largest category; icon scaling is bounded within enlarged tap targets.
- **Spacing/layout rhythm:** avatar centered within the available stage; safe-area-aware header and controls; bounded 700-point content width on iPad. The stage scrolls on short windows or large text. Mute, End and minimize remain reachable in tested portrait and landscape states.
- **Colors/tokens:** dark navy stage, pale blue shared avatar and microphone waveform, white primary action, subdued status and secondary control surfaces. Waveform settles when muted. Reduce Motion changes intensity without animated bar movement.
- **Image/asset quality:** uses the exact shared Three.js avatar renderer, rather than a new raster approximation. The real Blender GLB remains a future supplied asset; self-contained GLBs use the shared animation/mouth contract. Native SF Symbols are used for controls. The waveform is a data visualization driven by microphone RMS, not decorative artwork.
- **Copy/content:** clear listening/muted/connecting/ending states, explicit offline preview label, no transcript in fullscreen voice, retry-saving notice when needed. Transcript persistence remains part of the same chat.

## Comparison history

1. [P2] Initial native avatar overlapped the captions. Separated the avatar stage from controls; later removed captions entirely per the user's updated requirement.
2. [P2] Largest accessibility text caused icons to outgrow their fixed circles and pushed minimize outside the landscape hit region. Bounded symbol scaling, enlarged control targets, added a scrollable stage, preserved bottom actions, and removed redundant footer text at accessibility sizes. Final `voice-large-text.png` and `voice-landscape.png` show the correction; both UI tests pass.
3. [P2] iPad avatar sat too high in a tall stage. Centered the avatar within the measured scroll viewport while keeping the header at the top. Final `voice-ipad.png` and `voice-fullscreen.png` show the correction; UI tests were rerun after this change.
4. Final combined full-screen and focused-control comparison: no remaining actionable P0/P1/P2 differences. Native safe areas, larger system text, the removal of captions, and the microphone waveform are expected adaptations.

## Verification and remaining limits

- Xcode 27 / iOS 27 simulator build passes.
- 87 CollectiveKit tests, 29 native app tests, 39 targeted server/voice/auth-coverage tests, and 2 voice UI regressions pass.
- UI checks exercise mute state and waveform accessibility value, absence of captions, minimize, typing into the same chat, restore, End, retained draft, largest text, and landscape controls.
- Typecheck, targeted ESLint, generated-engine freshness and diff whitespace checks pass.
- Shared protocol tests cover delegation, partial transcript ordering, durable retries, tool approval boundaries, and ending without starting new work. Native request tests restrict operations to voice endpoints and the bound chat; mobile gateway tests check authentication and avatar bounds.
- Live OpenAI audio, microphone/echo/Bluetooth behavior on hardware, interruption/background behavior on a device, real Decisions latency, and the unfinished custom Blender asset were not verified. Offline previews make no paid API calls and do not open the microphone. Full manual VoiceOver navigation and iPhone Duo folding were not performed.

**Implementation checklist:** complete for the local feature; next validate a real voice session on an iOS 27 device with the configured server.

final result: passed

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

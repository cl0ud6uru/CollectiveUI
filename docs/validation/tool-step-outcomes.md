# Tool-step outcome visibility

Follow-up to the structured-failure repair in `ee55b3c`:

- Completed web replies retain denied and unfinished tool rows beside the collapsed summary. The summary counts denials/interruption and uses an attention glyph, reserving its checkmark for completed steps.
- Both `output-denied` and a negative `approval-responded` are denials, including workspace command approvals. A denied call never renders a running ticker. Other unfinished tools in a finished reply show interrupted, including ordinary tools as well as remote tools; expanded interrupted rails do not pulse.
- The shared iOS/macOS `ToolSteps.swift` keeps denied rows beside the collapsed chip, counts denials and uses a raised-hand glyph. Native active/approval steps already remain on the rail, so they cannot collapse into a success chip; that behavior is retained.
- Delegated errors already presented by `DelegationCard` are not repeated in the generic collapsed failure paragraph. A distinct structured failure message remains visible when the card does not present it.

Verification:

- Five new real `AssistantMessage` rendering regressions fail against `ee55b3c`: the two denial states, two unfinished input states, and duplicated sanitized delegated error. All pass after this change.
- Final focused web suite: **49/49** across tool-step outcomes, delegation card/activity and delegated approvals. This includes preservation of distinct structured delegation failures and mixed completed/denied/interrupted replies.
- Web typecheck, targeted ESLint and diff checks passed.
- Unchanged synthetic headless delegation browser flow passed desktop and mobile widths, including strict single-error matching, keyboard expansion, streaming updates and visible approvals.
- Native `StreamReducerTests`: **13/13**; shared `ToolSteps.swift` Swift syntax and SwiftUI typecheck passed against the real CollectiveKit module, with only ChatModel/theme stubs. Both native projects use this shared view source. This is source/model verification; no native app, simulator or GUI was launched, and there is no visual screenshot acceptance from this check.

No provider, account, configuration, installed build or service changes.

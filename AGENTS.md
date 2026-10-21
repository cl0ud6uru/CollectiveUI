<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cross-platform UI parity

- When adding, changing, or removing UI, review the equivalent web, iOS, and macOS surfaces and keep them consistent where applicable.
- Check feature capabilities, command discovery and execution, recovery and error behavior, and UI removals across all three clients. A removal on one platform should prompt a review of the others.
- Platform-native presentation is welcome. Document intentional differences, including platform constraints or unavailable capabilities, and cover them with appropriate automated tests or recorded manual validation.
- Include the affected platforms and parity checks in the change description; do not silently leave a client behind.

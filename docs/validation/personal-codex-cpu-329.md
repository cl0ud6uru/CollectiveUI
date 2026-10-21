# Personal Codex fractional CPU inspection

The Docker broker now converts its configured CPU count to an integer nanocpu value before comparing the inspected limit. Fractional counts such as 4.1 previously produced a noninteger JavaScript product and rejected an otherwise correctly retained container.

The Docker-boundary regression exercises the production inspection and retained-start paths for every hundredth-CPU setting from 0.25 through 8.00. Its expected limits use integer arithmetic independent of the production conversion. Limits one nanocpu above or below the expected value remain rejected; no tolerance or isolation guard was relaxed.

Before the fix, the new supported-range regression fails while the existing 59 cases pass (one optional real-Docker fixture skips). After the fix all 60 cases pass, with that optional fixture still skipped. This uses the existing command-boundary fake and never starts Docker, creates a real container, changes an installed broker configuration or contacts a provider.

This is a server broker correction shared by web, iOS and macOS clients. No client UI or API contract changes.

# Retained Codex usage after errors (#333)

The run adapter now saves the latest cumulative native token counters even when the turn errors. If the runtime reports no counters, the update omits that field and retains the previous baseline, including an explicitly unknown baseline. A later observed cumulative value re-establishes a known baseline; missing counters are never replaced by zero.

The production run adapter and real local WebSocket protocol fixture cover three managed-thread sequences: observed counters before an error yield per-turn input deltas `[7,7,7]`; an error without new counters retains the previous baseline and the next report accounts for the unreported interval as `[7,null,14]`; a previously unknown baseline stays unknown as `[7,null,null]` until a new cumulative value is retained. The latter two cases cannot split unreported usage between turns. Subscription attribution, null API costs, thread/binding/branch fences, and runtime authorization remain unchanged.

These are synthetic local protocol fixtures with disposable database and sockets. They do not start Codex, call a provider, change account configuration, or exercise native client UI. This server correction applies to web, iOS and macOS clients.

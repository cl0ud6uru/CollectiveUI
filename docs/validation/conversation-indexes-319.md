# Conversation reference indexes

Issue #319: deleting conversations could repeatedly scan six dependent tables, and the bot activity list lacked an index for its user/bot/time filter.

Generated migration 0068 adds six conversation-reference indexes and a `(user_id, bot_id, created_at)` tool-call index. A backward scan supports the existing descending activity query. Existing indexes and all foreign-key/delete behavior remain unchanged. This follows the reviewed event migration 0067 and preserves its history.

The embedded PostgreSQL migration regression applies the prior schema, seeds all six reference types plus 500 tool-call rows, and shows sequential scans for each conversation lookup before migration even when sequential scans are discouraged. After migration, each lookup uses its dedicated index and the activity query uses the composite index without a sort. Every seeded row remains unchanged; conversation deletion retains its existing cascade and nulling behavior. This establishes index eligibility and migration behavior, not a production timing benchmark. Unrelated pgvector columns use array substitutes in this fixture.

Typecheck and focused migration tests pass. No database outside disposable fixtures, installed client, provider, service, or production configuration was changed. Large existing audit tables still affect the duration of the ordinary index-building migration; production deployment is a separate operation.

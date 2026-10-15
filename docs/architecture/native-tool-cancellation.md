# Native connector cancellation

Microsoft 365 mail, calendar and file tools receive the native run's cancellation signal. A tool stopped before dispatch makes no connector request. The delegated-token lookup and refresh path rechecks cancellation before sending the Graph operation, and the same signal reaches both token-refresh and Graph HTTP requests. No canceled operation is retried automatically.

Graph's 202 mail acknowledgement and 204 response are accepted from their status headers without reading a body that Stop could still abort. Other JSON parsing failures and cancellation errors propagate; their message text cannot turn a failed request into a successful send. A successful acknowledgement still reports acceptance when cancellation arrives afterward. A real loopback HTTP regression holds the response body open and aborts after the headers arrive to exercise this race through the HTTP helper.

Stop cancels the local HTTP request. It cannot recall a message or prove that an in-flight remote action did not happen. Existing durable-run closing behavior retains uncertain interrupted tool outcomes; users should inspect the remote mailbox before retrying a send whose outcome is unknown. The mail tool continues to require the existing user approval.

Synthetic regression coverage: `tests/unit/m365-cancellation.test.ts`, `tests/unit/entra-cancellation.test.ts`, and the existing run closing/replay suites. No real account, token refresh, message or provider request is required for these tests.

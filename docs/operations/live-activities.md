# iOS Live Activities

Phase one shows the selected pet as a static pose, a generic run status and a link back to the exact chat.
It includes all Dynamic Island presentations and the Lock Screen card. Approval decisions remain in chat.
No task title, prompt, reply, tool input, error detail, bot name, email or account id is displayed.
Settings → Live Activities → Show bot status is off by default; enabling it discloses the selected pet on system surfaces.

## Behavior

- Foreground starts only; one activity per durable direct-bot chat run, up to three per sign-in/device.
  Group chats, model-only chats, routines and delegates do not start activities in phase one.
- The app polls an authorized snapshot every 10 seconds while foregrounded. Navigation away from chat leaves
  its activity running. Reopening restores activities and reconciles the pinned run, instead of adopting a newer turn.
- Working/queued, attention (including approval waits), completed, failed/interrupted and confirmed stopped states
  use different static poses/glyphs. A stop request alone never claims the run was cancelled. No invented percentage.
- Custom/catalog pets use four 24×26, 16-color stills from the authenticated effective atlas. Their bounded
  paletted data fits in the activity attributes; the widget never fetches images or receives credentials.
  Moss and Ember reuse native Seedling artwork. Missing/unavailable pets use a neutral symbol.
- Local sign-out, session loss, server change and opt-out end activities immediately. Session revocation removes
  server registrations. Account disablement/version change, auth-provider disablement, bot access changes and
  expiry are rechecked before delivery. Remote revocation while the app is suspended stops future pushes; a card
  already on the device becomes stale until the app opens or iOS removes it. APNs cannot guarantee an immediate wipe.
- Unchanged background state is deduplicated; a low-priority freshness update is sent every 90 seconds.
  The widget marks content stale after 3 minutes. Terminal activities end with final content and a 5-minute dismissal.
  Registration expires after 8 hours, matching ActivityKit's maximum running lifetime.
- Activity tokens rotate through `pushTokenUpdates`, with persistent monotonic versions and bounded retries.
  Relaunch retries the current token. Duplicate run/token registrations and stale rotations are refused.
  User-dismissed runs are remembered within the current local sign-in, so foreground reconciliation does not reopen them.

## Apple and server setup — separate approval required

The checked-in app works with foreground updates. Push is **disabled on both sides**. There are no signing teams,
APNs credentials, push/App Group entitlements or enabled Apple account capabilities in this change.
The server implementation and synthetic delivery tests do not establish real background delivery.

Before enabling push, the operator must approve and complete all of these steps:

1. Use an Apple Developer team with appropriate provisioning access. Register an owned app bundle identifier and
   its `.liveactivity` widget identifier. Set `COLLECTIVE_BUNDLE_ID` for both targets and select the same signing team.
   Paid membership/enrollment, if needed, is outside this implementation.
2. Approve enabling Push Notifications for the app identifier in the Apple Developer account/Xcode. Regenerate
   provisioning profiles so the app's signed `aps-environment` entitlement matches the selected sandbox or production
   environment. Do not add an App Group; this implementation does not require one.
3. Obtain an operator-managed APNs authentication key with the needed app access, note its key ID and team ID, and
   mount its `.p8` file read-only in **both** web and worker services. Do not commit, log, paste into a PR, or create keys
   during ordinary development. Use the installation's existing production encryption keyring for token storage.
4. With action-time approval, change `CollectiveLiveActivityPushEnabled` in the app Info.plist to `true`, and configure
   the following environment variables in both server services. `APNS_BUNDLE_ID` is the **app**, not widget, identifier.

   ```text
   LIVE_ACTIVITIES_ENABLED=true
   APNS_TEAM_ID=<10-character team identifier>
   APNS_KEY_ID=<10-character authentication-key identifier>
   APNS_BUNDLE_ID=<owned app bundle identifier>
   APNS_ENVIRONMENT=sandbox
   APNS_KEY_FILE=<read-only mounted .p8 path>
   ```

5. Apply migration `0029_live_activities` to a separately approved environment; restart the worker and web service.
   Allow verified TLS HTTP/2 egress to `api.sandbox.push.apple.com:443` or `api.push.apple.com:443`, matching the
   provisioning environment. No APNs hostname, topic, environment, owner or device id is accepted from the client.
6. Validate on a properly signed physical device: start while foregrounded, background/terminate the app, complete
   and fail runs, rotate tokens, disconnect/reconnect, confirm opt-out/logout and server revocation, and open the
   right account/bot/chat from each presentation. Check delivery ordering, APNs throttling, iOS Settings disabled,
   devices without Dynamic Island and iPad/StandBy. Only then describe background delivery as verified.

No push-to-start or broadcast tokens, alert notifications, frequent-update entitlement, or approval action buttons
are included. Low-priority APNs delivery is best effort and subject to Apple/system budgets and network availability.

## Backend contract

- `GET /api/mobile/v1/conversations/:id/activity?runId=:runId` returns an owner/access-checked, generic snapshot.
  Omit `runId` only when initially finding the current turn. `backgroundUpdates` reports server configuration,
  not verified device delivery. This endpoint still works with APNs off.
- `POST /api/mobile/v1/live-activities` accepts only `activityId`, `runId`, hex `pushToken`, and integer `tokenVersion`.
  The authenticated mobile session supplies owner/device scope. APNs tokens are encrypted with row-bound AAD
  and stored with hashes for collision checks. No API response exposes them. Invalid request/config/transport
  errors never log raw tokens or keys.
- `DELETE /api/mobile/v1/live-activities` removes this session's registration for `activityId`, or all with `{}`.
  This ends delivery, not the server task. Native code ends its corresponding ActivityKit objects.
- The worker polls durable registrations every 15 seconds; session/activity row locks serialize replicas,
  rotation and logout. Successful delivery records a monotonic APNs timestamp, and retry/backoff survives restart.
  APNs invalid/unregistered tokens are removed; configuration failures back off with generic diagnostics.
  Expired registrations are purged by the worker even with push disabled. With push off, no new registrations
  are accepted; revocation/cascade deletion still removes existing rows.

## Validation

```sh
swift test --package-path ios/CollectiveKit
xcodebuild -project ios/CollectiveUI.xcodeproj -scheme CollectiveUI \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
npx vitest run --project unit tests/unit/live-activity-*.test.ts
npm run typecheck
npm run lint
```

The tests cover privacy/payload structure, variable-length malformed tokens, ES256 JWT and documented HTTP/2 headers,
owner/session isolation, rotation/deduplication, concurrent-run caps, logout/revocation, permission/expiry checks,
foreground-only starts, completion/attention/cancellation, retries, stale content and deep-link scope.
The database suite runs all migrations in an embedded PostgreSQL fixture; unrelated pgvector columns use `real[]`.
It doesn't exercise multiple PostgreSQL processes, live APNs, Apple signing or real device background delivery.

Debug builds have an offline QA screen using the widget's shared views:

```sh
xcrun simctl launch <isolated-device-uuid> io.collectiveui.app \
  --demo --demo-screen liveactivity --demo-native-activity --demo-activity-phase working
```

The optional native activity fixture uses no push token. Use an isolated simulator to avoid affecting another
session. The QA screen is excluded from Release. SwiftUI widget previews cover Lock Screen and Island layouts.

# Personal bot navigation

The Bots directory has a Pin/Unpin button for each bot you can use. Pins belong to your account, including for shared bots. A new pin appears after your existing pins; pinning a hidden bot also unhides it. Unpinning preserves its position. Pinning never changes a bot's audience or configuration.

Drag a sidebar bot by its grip and drop at the insertion line to move it. On a keyboard or touch screen, activate the grip or the bot's options button and choose **Move up** or **Move down**. Moves can cross pinned entries and retain each bot's pinned state. The full visible roster stays in the scrollable sidebar so a move cannot remove the focused bot. A successful move is announced and focus returns to the moved bot's options button. Cancelling a drag leaves the arrangement unchanged.

Order, pins and hidden state are saved to your account across refreshes, navigation, and later sessions. Incoming messages, activity and renamed bots do not reorder the list. Newly accessible bots follow the existing saved arrangement. Recent Chats keeps its own chronology.

Both surfaces update immediately while saving, and further changes are disabled until the save finishes. A failed save restores the saved arrangement and shows an error. Hidden bots can be shown again from the sidebar; their routines keep running. Deleted or inaccessible bots are filtered from the current authorized roster even if a saved preference references them. Pins never retain access.

The order uses `users.prefs.botOrder`; pins and visibility use the existing `user_bot_prefs` table. Saving locks the signed-in user's row, verifies current permissions, and updates pins/order in one transaction while preserving unrelated preferences. No database migration is needed. Other users' preferences and the shared bot record are not modified.

Regression checks: `npm test`, plus the real-Postgres `tests/integration/bot-navigation.test.ts`. Browser checks use `BOT_NAVIGATION_BROWSER=1`, a migrated disposable database named `collective_navigation_test` on `127.0.0.1`, local authentication, and `npx playwright test --config tests/bot-navigation.playwright.config.ts` against the local app (default port 3121). These fixtures use synthetic accounts and do not make provider calls.

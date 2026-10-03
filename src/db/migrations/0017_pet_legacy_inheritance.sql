-- 0016 remains immutable for installations that already applied it.
-- The legacy toggle defaulted off, but appearance/motion/import changes also stored
-- disabled rows. No history distinguishes those from deliberate opt-outs. Reset
-- ambiguous rows once to Follow; retain all private bytes, credit and selections.
-- Catalog selections prove post-0016 explicit mode use, so preserve their Off state.
-- Legacy-shaped Off choices made after 0016 are also ambiguous and may need to be
-- selected again. Future explicit Off writes survive normal migration reruns.
UPDATE "bot_pets" SET "mode" = 'follow'
WHERE "mode" = 'off' AND "enabled" = false AND "catalog_id" IS NULL;

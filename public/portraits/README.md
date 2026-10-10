# Hermes Assimilated sidebar portrait

`hermes-assimilated.png` is the user-supplied transparent cutout of the full-body 2D portrait, preserved byte for byte at 1024 × 1536 pixels (2,180,226 bytes).

SHA-256: `2fe203809023389661433ab19b2073615ab8317f581d3a4768a18538fce81f6d`

The earlier opaque RGB portrait had SHA-256 `d4a4768441b51f80c1bbc72fd2f31cc569c3044ce06b59fefd73569859fbccc7`. The supplied image edit removes its embedded backing while retaining the character's appearance and full-body framing; character RGB is not asserted to be pixel-identical to that earlier image. The RGBA cutout has 868,703 fully transparent pixels, alpha range 0–254, and corner alpha 0, 0, 1, 0. Browser captures verify compositing against both sidebar themes, without a rectangle or conspicuous halo.

The web bot-details sidebar displays this still portrait below activity, routines and actions when the viewer's effective pet is `builtin-hermes-assimilated-v2`. Off, private imports and other catalog choices have no portrait. The image uses containment and transparent outside edges, and adds no animation. Missing files leave no portrait frame; the controls remain available.

The existing [Hermes Assimilated artwork notice](../../assets/pets/hermes-assimilated/README.md) also applies to this portrait and its screenshot reproductions. It is excluded from the application's MIT license. This file is separate from the animated pet atlas.

Synthetic browser verification: `node tests/browser/bot-sidebar-portrait.mjs`. Set `BOT_PORTRAIT_SCREENSHOTS` to save light/dark, narrow and short/busy captures. No accounts, chat data or inference are used.

# Redrawing a bundled pet at 2×

Each bundled pet is a Codex Pet v2 sheet: 73 frames of 192 × 208 pixels. On dense
(retina) screens the sign-in companion and large bot avatars are drawn wider than
that, so they look soft. A 2× redraw (384 × 416 per frame) fixes this and still
ships a standard v2 sheet. This page covers the steps every pet shares; each pet's
own brief describes her character and poses:

- [Hermes](hermes/REDRAW-2X.md)
- [Hermes Assimilated](hermes-assimilated/REDRAW-2X.md)

## What gets made

One set of 73 transparent frames at **384 × 416**. From them,
`scripts/build-pet-hd.ts` produces both shipped files:

| File | Size | Who uses it |
| --- | --- | --- |
| `v2/spritesheet.webp` | 1536 × 2288, standard Codex Pet v2 | Every Codex Pets app, ZIP export, and CollectiveUI on ordinary screens |
| `v2/spritesheet@2x.webp` | 3072 × 4576, same layout | CollectiveUI only, when an avatar is drawn wider than its v2 frame |

`pet.json` doesn't change and never mentions the 2× file, so the pet stays a
plain v2 pet everywhere else. The v2 sheet is shrunk from the redraw, so it
improves too.

## 1. Make reference frames

```bash
npx tsx scripts/export-pet-frames.ts assets/pets/hermes/v2/spritesheet.webp /tmp/hermes-reference
```

This writes `0-1.png` … `10-8.png`: every current frame enlarged to 384 × 416.
They're soft on purpose. Use them to fix each frame's pose, expression, framing
and position; the redraw supplies the detail. Also give the image model the pet's
original concept image (named in her brief) for identity and costume detail.

## 2. Redraw each frame

Work row by row, so a sequence's frames come from the same session and look
consistent. For each frame, give the model that frame's reference, the concept
image, and the pet's prompt. Then:

- **Keep registration.** The character must sit in exactly the same place and
  scale as in the reference, or the animation jitters. If the model's canvas is a
  different size (say 1024 × 1024), center the reference on a canvas of that
  size, generate, crop the same rectangle back out, and resize it to 384 × 416.
  Use the same crop for every frame.
- **Transparent background.** Use the model's transparent-background option. If
  there isn't one, generate on flat magenta (`#FF00FF`) and key it out. Never use
  green, which would eat the pet's green accents.
- **Clear border.** Leave at least 8 fully transparent pixels on every side of
  each 384 × 416 frame. About 10% padding, like the current art, is better.
- **No extras:** no shadow, floor, text, watermark, frame or second character.

Save each finished frame with its reference's name (`0-1.png`, …) in one folder.

## 3. Build and check

```bash
npx tsx scripts/build-pet-hd.ts /tmp/hermes-redraw assets/pets/hermes/v2
```

The script refuses missing or wrongly sized frames and frames that touch their
border. It runs the installer's own checks: v2 cell layout at both sizes,
importability, and a likeness check that the two sheets are the same art. It then
prints each file's size and SHA-256.

If the shrunk v2 sheet would decode past the importer's 4 MB limit, the script
rounds its colors to four-value steps (at most 2 of 255 per channel), as the
shipped Assimilated sheet already does, and says so.

Then review by eye. Play each row in Admin → Pets, compare against the old frames
at 28, 56 and 112 pixels in light and dark mode, and check that identity doesn't
drift between frames.

## 4. Ship it

Using the hashes the build script printed:

1. In `src/lib/pets/bundled.ts`, find the pet's `BUNDLED_PETS` entry: move its
   current `sprite` hash into `releases`, set `sprite` to the new
   "normalized v2 PNG" hash, and set `hd: true`. Installations still on an
   official release then upgrade at the next migration. Artwork an operator
   replaced is never touched.
2. In `tests/unit/bundled-pets.test.ts`, update the pet's `hash` (the
   `spritesheet.webp` SHA-256) and `normalizedBytes`.
3. Update the pet's `README.md` hash table and add the redraw's provenance to her
   `SOURCE-README.txt`: tool, date, references used, and any color rounding.
4. Run `npm test`. Also run the bundled-pet integration tests from
   [README.md](README.md#reproducible-validation).

An upgrade gives the artwork a new revision. If the pet is the public sign-in
companion, an admin must confirm it again under Admin → Settings before the new
art shows there.

# Hermes: 2× redraw brief

Follow [the shared process](../REDRAW-2X.md). This page is what to hand the image model.

## References

- Every frame: `npx tsx scripts/export-pet-frames.ts assets/pets/hermes/v2/spritesheet.webp /tmp/hermes-reference`
- Identity: the approved green concept, `hermes-green-concept.png`. It isn't in this repository; the person who
  supplied the original bundle has it (see [SOURCE-README.txt](SOURCE-README.txt)).

## Who she is

A friendly anime-style companion, shown waist-up, in the same close portrait framing as today.

- **Hair:** very long, straight, black, with blunt bangs. Thin neon-green strands run through it and catch the light.
- **Face:** soft and friendly, with light blue eyes and a small, warm smile.
- **Headset:** a thin neon-green headband with round, ring-shaped earcups glowing green.
- **Outfit:** a matte black, high-collared bodysuit with neon-green piping. A green O-ring sits at the collarbone,
  with a harness line running to two small square buckles. Green-banded cuffs, black gloves.
- **Palette:** black and charcoal, neon green (about `#39FF14`), skin, light blue eyes. No other accent colors.
- **Style:** clean anime cel shading with crisp line art. Even, soft front lighting the same in every frame.

## Prompt for each frame

> Redraw the reference image as a clean, high-detail illustration of Hermes: [the "Who she is" bullets]. Keep exactly
> the reference's pose, expression, gesture, framing and position on the canvas. Only sharpen detail: line art, hair
> strands, eyes, the headset and costume trim. Transparent background, no shadow, no text, no other objects.

Add the row's note below. If the model drifts, attach the concept image again.

## Rows

Frame counts are fixed. Unused cells stay empty.

| Row | State | Frames | What the reference shows; keep it |
| --- | --- | --- | --- |
| 0 | Idle | 6 | Standing calmly, hands clasped at her waist. Small breathing and head changes, with a blink in frame 4. |
| 1 | Running right | 8 | Upper-body jog toward screen right: arms pumping, fists, hair streaming behind her to the left. |
| 2 | Running left | 8 | The same jog toward screen left, hair streaming to the right. Not a mirror image: the headset and harness stay on the same sides. |
| 3 | Waving | 4 | Raised hand waving hello, smiling; a happy closed-eye smile in frame 3. |
| 4 | Jumping | 5 | A buoyant hop, framed from the waist up: rising, an excited open smile with raised fists, then settling. |
| 5 | Failed | 8 | Something went wrong: worried and pouting looks, a hand to her chin, then recovering. |
| 6 | Waiting | 6 | Waiting for your approval: patient, small hand gestures, including a wink. |
| 7 | Working | 6 | Focused, typing on a keyboard just below the frame. |
| 8 | Review | 6 | Reading a tablet: hand to chin, stylus, a satisfied closed-eye nod. |
| 9–10 | Gaze | 8 + 8 | Head and eyes turn toward 16 directions clockwise from up (0°) in 22.5° steps: 90° is screen right, 180° down, 270° screen left. Body stays put. |

Gaze frames are part of v2 but aren't animated in CollectiveUI yet. Still redraw all 16 so the pet stays complete.

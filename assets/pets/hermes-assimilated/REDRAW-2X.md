# Hermes Assimilated: 2× redraw brief

Follow [the shared process](../REDRAW-2X.md). This page is what to hand the image model.

## References

- Every frame: `npx tsx scripts/export-pet-frames.ts assets/pets/hermes-assimilated/v2/spritesheet.webp /tmp/assimilated-reference`
- Identity: the selected Seven Echo concept, `hermes-borg-01-seven-echo.png`. It isn't in this repository; the person
  who supplied the original bundle has it (see [SOURCE-README.txt](SOURCE-README.txt)).
- Framing: the current close waist-up bust, which already matches green Hermes. Keep it; don't go back to the
  earlier full-body poses.

## Who she is

Hermes after a friendly cybernetic makeover: the same face and hair, with silver implants and emerald light.
Unofficial, Borg-inspired fan art.

- **Hair:** very long, straight, black, with blunt bangs and thin emerald-green strands.
- **Face:** soft and friendly with a warm smile. Her right eye (viewer's left) is natural light blue. Her left eye
  (viewer's right) is a glowing emerald cybernetic eye, with fine silver circuit implants curving around it.
- **Headset:** silver-and-black ring earcups glowing emerald, on a thin band.
- **Implants:** segmented silver armor plating down her right arm (viewer's left), with emerald ring joints at the shoulder,
  elbow and wrist. Silver rib implants along her side, and a glowing emerald ring emblem at the center of her chest.
- **Outfit:** a matte black bodysuit with emerald conduit lines, plus mechanical silver-and-black gloves on both
  hands. Keep the gloves mechanical in every frame.
- **Palette:** black, gunmetal and silver, emerald green (about `#3CE05A`), skin, one light blue eye. No other accents.
- **Style:** clean anime cel shading with crisp line art and polished metal highlights. Lighting is the same in every
  frame.

## Prompt for each frame

> Redraw the reference image as a clean, high-detail illustration of Hermes Assimilated: [the "Who she is" bullets].
> Keep exactly the reference's pose, expression, gesture, framing and position on the canvas. Only sharpen detail:
> line art, hair strands, both eyes, the implant plating and circuitry, the gloves and the headset. Implants stay on
> the same side of her body in every frame. Transparent background, no shadow, no text, no other objects.

Add the row's note below. If the implants move sides or vanish, attach the concept image again.

## Rows

Frame counts are fixed. Unused cells stay empty.

| Row | State | Frames | What the reference shows; keep it |
| --- | --- | --- | --- |
| 0 | Idle | 6 | Standing calmly, mechanical hands gently clasped near her waist. Small breathing and head changes, with a wink in frame 4. |
| 1 | Running right | 8 | Upper-body jog toward screen right: arms pumping, hair streaming behind her. |
| 2 | Running left | 8 | The same jog toward screen left. Not a mirror image: the cybernetic eye stays on her left and the armored arm on her right. |
| 3 | Waving | 4 | One hand raised in a wave, smiling; a closed-eye grin in frame 3. |
| 4 | Jumping | 5 | A buoyant hop, framed from the waist up: rising, excited open smile, fists raised, then settling. |
| 5 | Failed | 8 | Something went wrong: worried looks, hands together at her chin, then recovering. |
| 6 | Waiting | 6 | Waiting for your approval: patient, small gestures with the gloved hands, including a wink. |
| 7 | Working | 6 | Focused, typing on a keyboard just below the frame. |
| 8 | Review | 6 | Reading a tablet: finger to chin, a wink, a satisfied nod. |
| 9–10 | Gaze | 8 + 8 | Head and eyes turn toward 16 directions clockwise from up (0°) in 22.5° steps: 90° is screen right, 180° down, 270° screen left. The cybernetic eye stays on the same side as she turns. |

Gaze frames are part of v2 but aren't animated in CollectiveUI yet. Still redraw all 16 so the pet stays complete.

The shipped v2 sheet already rounds its colors to fit the 4 MB import limit. Expect the build script to do the same
for the redraw.

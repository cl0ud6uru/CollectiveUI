# The Queen v2

An original crowned seedling robot: a calm, friendly coordinator in CollectiveUI’s Moss and Ember visual family.

AI-assisted design; vector production artwork adapted from CollectiveUI's original MIT-licensed Moss/Ember visual family.

The user supplied `The-Queen-CollectiveUI-v2.zip`. Its [historical source notice](SOURCE-README.txt)
identifies the final pixels as native vector artwork adapted from CollectiveUI's
Moss/Ember, with image generation used for concept exploration only. The supplied
[MIT license](LICENSE.txt), original PNG and original manifest are retained here.
This is the crowned seedling robot, distinct from either Hermes pet.

The supplied atlas uses all 88 cells, placing neutral poses in the 15 cells that
current v2 validation requires to be empty. `node scripts/prepare-queen-atlas.mjs`
assembles the runtime atlas by preserving every decoded RGBA pixel in the 73
required cells and making only the other 15 cells transparent. No required frame
is redrawn, resampled or reordered. The runtime manifest adds the source notice's
recommended credit; the name and description remain unchanged.

The historical notice's statement that ZIP imports are unsupported and its unused-cell
layout describe an older importer. Use `v2/pet.json` with `v2/spritesheet.png` today.
Its references to generation scripts and preview files describe the original delivery
ZIP; those extras are not runtime files and are not all bundled here. The current
app's preview can inspect all states and directions; ordinary bot avatars do not
track the cursor. This addition does not create or modify coordinator bots.

| File | SHA-256 |
| --- | --- |
| Supplied delivery ZIP | `e635a73a6f92948354898b1c3c5650dcf4675842996344d88b1de6acc76c4bb4` |
| `source/pet.json` | `5fc0cbe5e1ef703973f44c319a698062c5a7124f55ea37ea4b436013c7c04253` |
| `source/spritesheet.png` | `278d708803c686c9b854862a09df888cc63ce35d291817680df0a5523a7e3ad3` |
| `v2/pet.json` | `55b369deb235c017a8bb20487d8fc629694b7b9836281aee2f3199affdb6b11a` |
| `v2/spritesheet.png` | `fed57f8824f9e4a93064ab9e60996637867a583b2e3b83d3a175460560ac7487` |

See [installation and validation](../README.md).

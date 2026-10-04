/** Codex Pet v2: fixed 192 × 208 cells, eight columns, eleven rows. */
export const PET_ANIMATIONS = [
  { name: "idle", label: "Idle", durations: [280, 110, 110, 140, 140, 320] },
  { name: "running-right", label: "Running right", durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "running-left", label: "Running left", durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "waving", label: "Waving", durations: [140, 140, 140, 280] },
  { name: "jumping", label: "Jumping", durations: [140, 140, 140, 140, 280] },
  { name: "failed", label: "Failed", durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { name: "waiting", label: "Waiting", durations: [150, 150, 150, 150, 150, 260] },
  { name: "running", label: "Working", durations: [120, 120, 120, 120, 120, 220] },
  { name: "review", label: "Review", durations: [150, 150, 150, 150, 150, 280] },
] as const;
export const PET_DIRECTIONS = Array.from({ length: 16 }, (_, index) => ({
  row: 9 + Math.floor(index / 8), column: index % 8, degrees: index * 22.5,
  label: `${index * 22.5}°${index === 0 ? " · Up" : index === 4 ? " · Screen right" : index === 8 ? " · Down" : index === 12 ? " · Screen left" : ""}`,
}));
// Square slot heights; atlas widths fit the same 192/208 ratio as BotAvatar.
export const PET_AVATAR_SIZES = [20, 24, 28, 32, 48, 56, 64, 80, 84, 112] as const;

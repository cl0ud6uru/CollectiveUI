import { cn } from "@/lib/utils";

/**
 * Grok Bot-style blob avatars: a coloured shape with two little eyes.
 * Stored as "blob:<shape>:<color>"; any other value is rendered as an emoji.
 */
export const BLOB_SHAPES = ["circle", "triangle", "egg", "hexagon", "ghost", "drop", "pill"] as const;
export const BLOB_COLORS = {
  purple: "#8b5cf6",
  pink: "#ec4899",
  orange: "#f97316",
  teal: "#14b8a6",
  yellow: "#eab308",
  blue: "#3b82f6",
  red: "#ef4444",
  grey: "#9ca3af",
  black: "#18181b",
} as const;
export type BlobShape = (typeof BLOB_SHAPES)[number];
export type BlobColor = keyof typeof BLOB_COLORS;

export function parseBlob(value?: string | null): { shape: BlobShape; color: BlobColor } | null {
  const m = /^blob:([a-z]+):([a-z]+)$/.exec(value ?? "");
  if (!m || !BLOB_SHAPES.includes(m[1] as BlobShape) || !(m[2] in BLOB_COLORS)) return null;
  return { shape: m[1] as BlobShape, color: m[2] as BlobColor };
}

export function randomBlob(): string {
  const colors = Object.keys(BLOB_COLORS).filter((c) => c !== "grey");
  return `blob:${BLOB_SHAPES[Math.floor(Math.random() * BLOB_SHAPES.length)]}:${colors[Math.floor(Math.random() * colors.length)]}`;
}

function Shape({ shape, fill }: { shape: BlobShape; fill: string }) {
  switch (shape) {
    case "circle":
      return <circle cx="50" cy="50" r="42" fill={fill} />;
    case "triangle":
      return <path d="M50 12c5 0 8 3 11 8l29 50c5 9-1 18-11 18H21c-10 0-16-9-11-18l29-50c3-5 6-8 11-8z" fill={fill} />;
    case "egg":
      return <ellipse cx="50" cy="54" rx="36" ry="42" fill={fill} />;
    case "hexagon":
      return (
        <polygon
          points="50,10 86,30 86,70 50,90 14,70 14,30"
          fill={fill}
          stroke={fill}
          strokeWidth="10"
          strokeLinejoin="round"
        />
      );
    case "ghost":
      return <path d="M18 48a32 32 0 0 1 64 0v40c-6 0-8-4-16-4s-10 4-16 4-10-4-16-4-10 4-16 4z" fill={fill} />;
    case "drop":
      return <path d="M50 8c0 0 34 36 34 56a34 34 0 0 1-68 0C16 44 50 8 50 8z" fill={fill} />;
    case "pill":
      return <rect x="8" y="24" width="84" height="54" rx="27" fill={fill} />;
  }
}

/**
 * What a bot is doing, shown by its avatar instead of typing dots (like Grok Bot): idle blinks now and then, thinking
 * glances around, working bobs, waiting (for your approval) leans and looks at you. See `.blob-*` in globals.css.
 */
export type BlobState = "idle" | "thinking" | "working" | "waiting";

export function BlobSvg({ shape, color, className, state }: { shape: BlobShape; color: BlobColor; className?: string; state?: BlobState }) {
  const eyeY = shape === "pill" ? 42 : shape === "triangle" ? 52 : 44;
  return (
    <svg viewBox="0 0 100 100" className={cn(state && `blob blob-${state}`, className)} aria-hidden>
      <g className="blob-body">
        <Shape shape={shape} fill={BLOB_COLORS[color]} />
        <g className="blob-eyes">
          <rect x="38" y={eyeY} width="7" height="15" rx="3.5" fill="white" transform={`rotate(-14 41 ${eyeY + 7})`} />
          <rect className="ocular" x="55" y={eyeY} width="7" height="15" rx="3.5" fill="white" transform={`rotate(-14 58 ${eyeY + 7})`} />
        </g>
      </g>
    </svg>
  );
}

/**
 * Colours for your messages in a bot's chat, from its avatar (like ChatGPT dots). Every pair passes WCAG AA (4.5:1):
 * saturated colours are darkened a little under white text, light ones take dark text. Black and emoji avatars use ink.
 */
const BUBBLE_TINTS: Record<BlobColor, { bg: string; fg: string } | null> = {
  purple: { bg: "#8457ea", fg: "#ffffff" },
  pink: { bg: "#cb3e84", fg: "#ffffff" },
  blue: { bg: "#3472d8", fg: "#ffffff" },
  red: { bg: "#d53d3d", fg: "#ffffff" },
  orange: { bg: "#f97316", fg: "#111111" },
  yellow: { bg: "#eab308", fg: "#111111" },
  teal: { bg: "#14b8a6", fg: "#111111" },
  grey: { bg: "#9ca3af", fg: "#111111" },
  black: null,
};

export function bubbleTint(value?: string | null): { bg: string; fg: string } {
  const blob = parseBlob(value);
  return (blob && BUBBLE_TINTS[blob.color]) || { bg: "var(--accent)", fg: "var(--accent-fg)" };
}

export function BaseBotAvatar({ value, size = 20, className, state }: { value?: string | null; size?: number; className?: string; state?: BlobState }) {
  const blob = parseBlob(value);
  if (blob) return <BlobSvg {...blob} state={state} className={cn("shrink-0", className)} />;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center leading-none", state && state !== "idle" && "blob blob-emoji", className)}
      style={{ fontSize: size * 0.8 }}
    >
      {value || "🤖"}
    </span>
  );
}

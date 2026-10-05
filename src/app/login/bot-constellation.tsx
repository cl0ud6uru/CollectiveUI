import { BlobSvg, type BlobColor, type BlobShape } from "@/components/bots/bot-avatar";

/** The same blob family as bot avatars, floating around the sign-in companion. Inline vectors only, no external assets. */
const SATELLITES: { shape: BlobShape; color: BlobColor; x: number; y: number; size: number }[] = [
  { shape: "drop", color: "blue", x: 12, y: 2, size: 11 },
  { shape: "triangle", color: "pink", x: 76, y: -2, size: 12 },
  { shape: "hexagon", color: "teal", x: 70, y: 66, size: 12 },
  { shape: "pill", color: "orange", x: 15, y: 72, size: 11 },
  { shape: "egg", color: "yellow", x: 90, y: 47, size: 6.5 },
  { shape: "ghost", color: "purple", x: 2, y: 46, size: 6.5 },
];

export function BotConstellation({ children }: { children: React.ReactNode }) {
  return (
    <div className="bot-constellation">
      <div className="bot-constellation-stage">
        <div className="bot-main">{children}</div>
        {SATELLITES.map((s, i) => (
          <div key={i} aria-hidden="true" className="bot-satellite" style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.size}%`, animationDelay: `${i * 120}ms` }}>
            <BlobSvg shape={s.shape} color={s.color} state="idle" className="block w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

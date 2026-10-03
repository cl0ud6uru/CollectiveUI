import { BlobSvg, type BlobColor, type BlobShape } from "@/components/bots/bot-avatar";

/** The same blob family as bot avatars, orbiting the sign-in companion. Inline vectors only, no external assets. */
const SATELLITES: { shape: BlobShape; color: BlobColor; x: number; y: number; size: number; label?: string }[] = [
  { shape: "drop", color: "blue", x: 9, y: 14, size: 15, label: "RESEARCH" },
  { shape: "triangle", color: "pink", x: 77, y: 12, size: 14, label: "CREATE" },
  { shape: "hexagon", color: "teal", x: 66, y: 66, size: 13, label: "AUTOMATE" },
  { shape: "pill", color: "orange", x: 15, y: 68, size: 10 },
  { shape: "egg", color: "yellow", x: 88, y: 48, size: 7 },
  { shape: "ghost", color: "purple", x: 3, y: 44, size: 7 },
];

export function BotConstellation({ children }: { children: React.ReactNode }) {
  return (
    <div className="bot-constellation">
      <div className="bot-constellation-stage">
        <svg viewBox="0 0 600 390" fill="none" focusable="false" aria-hidden="true" className="bot-constellation-orbits">
          <g className="bot-orbit" stroke="#ffffff" strokeOpacity=".09">
            <ellipse cx="300" cy="200" rx="250" ry="115" transform="rotate(-18 300 200)" />
            <ellipse cx="300" cy="200" rx="202" ry="154" transform="rotate(28 300 200)" />
          </g>
          <path className="bot-link" d="M120 105Q200 95 250 165M352 178Q432 111 480 95M330 262Q370 300 410 282" stroke="#ffffff" strokeOpacity=".14" strokeDasharray="4 8" />
          <g fill="#ffffff" fillOpacity=".35">
            <circle cx="174" cy="40" r="2.5" /><circle cx="470" cy="245" r="2.5" /><circle cx="250" cy="340" r="3" /><circle cx="394" cy="57" r="2" />
          </g>
        </svg>
        <div className="bot-main">{children}</div>
        {SATELLITES.map((s, i) => (
          <div key={i} aria-hidden="true" className="bot-satellite" style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.size}%`, animationDelay: `${i * 120}ms` }}>
            <BlobSvg shape={s.shape} color={s.color} state="idle" className="block w-full" />
            {s.label && <span className="bot-satellite-label">{s.label}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { Popover } from "radix-ui";
import { cn } from "@/lib/utils";
import { BLOB_COLORS, BLOB_SHAPES, BlobSvg, BotAvatar, parseBlob, randomBlob, type BlobColor } from "./bot-avatar";

export function AvatarPicker({
  value,
  onChange,
  className = "h-20 w-20",
  size = 80,
  reset,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  /** Box of the avatar on the trigger; `size` (px) must match it so emoji avatars fit too. */
  className?: string;
  size?: number;
  /** Optional "back to default" choice, e.g. the portal mark for branding. */
  reset?: { label: string; preview: React.ReactNode };
}) {
  const blob = parseBlob(value);
  const color: BlobColor = blob?.color ?? "blue";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="group relative rounded-full p-1 hover:bg-hover" aria-label="Change avatar">
          {!value && reset ? <span className={cn("flex", className)}>{reset.preview}</span> : <BotAvatar value={value} size={size} className={className} />}
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-fg px-2 py-0.5 text-[10px] text-bg opacity-0 group-hover:opacity-100">
            Change
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} className="z-50 w-72 rounded-2xl border border-border bg-popover p-3 shadow-lg">
          <div className="mb-2 text-xs font-medium text-subtle">Shape</div>
          <div className="grid grid-cols-7 gap-1">
            {BLOB_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onChange(`blob:${s}:${color}`)}
                className={cn("rounded-lg p-1 hover:bg-hover", blob?.shape === s && "bg-hover ring-1 ring-fg/30")}
                aria-label={s}
              >
                <BlobSvg shape={s} color={color} className="h-7 w-7" />
              </button>
            ))}
          </div>
          <div className="mb-2 mt-3 text-xs font-medium text-subtle">Colour</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(BLOB_COLORS) as BlobColor[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange(`blob:${blob?.shape ?? "circle"}:${c}`)}
                className={cn("h-6 w-6 rounded-full", color === c && "ring-2 ring-fg ring-offset-2 ring-offset-surface")}
                style={{ background: BLOB_COLORS[c] }}
                aria-label={c}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              placeholder="or an emoji"
              maxLength={4}
              defaultValue={blob ? "" : (value ?? "")}
              onChange={(e) => e.target.value && onChange(e.target.value)}
              className="h-8 w-24 rounded-lg border border-border bg-transparent px-2 text-center text-sm outline-none"
            />
            {reset && (
              <button type="button" onClick={() => onChange("")} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-hover">
                {reset.label}
              </button>
            )}
            <button type="button" onClick={() => onChange(randomBlob())} className="ml-auto rounded-full border border-border px-3 py-1 text-xs hover:bg-hover">
              Surprise me
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

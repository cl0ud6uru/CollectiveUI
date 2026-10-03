"use client";

import { cn } from "@/lib/utils";

export function GroupPicker({
  groups,
  value,
  onChange,
}: {
  groups: { id: string; name: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  if (!groups.length) return <p className="text-xs text-muted">No groups yet — create them under Admin → Groups.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((g) => {
        const on = value.includes(g.id);
        return (
          <button
            type="button"
            key={g.id}
            onClick={() => onChange(on ? value.filter((x) => x !== g.id) : [...value, g.id])}
            className={cn("rounded-full border px-3 py-1 text-sm", on ? "border-fg bg-fg text-bg" : "border-border hover:bg-hover")}
          >
            {g.name}
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { Select } from "@/components/ui/select";

type Choice = { id: string; name: string };
export type StartTarget = { defaultAppId?: string | null; defaultBotId?: string | null };

const encode = (v: StartTarget) => (v.defaultBotId ? `bot:${v.defaultBotId}` : v.defaultAppId ? `app:${v.defaultAppId}` : "");
const decode = (value: string) => ({
  defaultAppId: value.startsWith("app:") ? value.slice(4) : null,
  defaultBotId: value.startsWith("bot:") ? value.slice(4) : null,
});

/** Where new chats start: a model or a bot (never both), or "" to follow the next level's default. */
export function StartTargetSelect({ id, value, onChange, apps, bots, emptyLabel, botsLabel = "Bots", disabled }: {
  id?: string;
  value: StartTarget;
  onChange: (next: { defaultAppId: string | null; defaultBotId: string | null }) => void;
  apps: Choice[];
  bots: Choice[];
  emptyLabel: string;
  botsLabel?: string;
  disabled?: boolean;
}) {
  const current = encode(value);
  const known = current === "" || (current.startsWith("bot:") ? bots : apps).some((c) => c.id === current.slice(4));
  return (
    <Select id={id} aria-label="Start new chats with" value={current} disabled={disabled} onChange={(e) => onChange(decode(e.target.value))}>
      <option value="">{emptyLabel}</option>
      {!known && <option disabled value={current}>Unavailable default — choose a model or bot</option>}
      <optgroup label="Models">
        {apps.map((a) => <option key={a.id} value={`app:${a.id}`}>{a.name}</option>)}
      </optgroup>
      <optgroup label={botsLabel}>
        {bots.map((b) => <option key={b.id} value={`bot:${b.id}`}>{b.name}</option>)}
      </optgroup>
    </Select>
  );
}

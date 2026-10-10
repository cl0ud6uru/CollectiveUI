"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

export type UserOption = { id: string; name: string; email: string | null; upn: string; disabled: boolean };
export function UserPicker({ users, value, onChange }: { users: UserOption[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = users.filter(u => [u.name, u.email, u.upn].some(v => v?.toLowerCase().includes(query)));
  return <div className="space-y-2">
    {value.length > 0 && <div className="flex flex-wrap gap-2">{users.filter(u => value.includes(u.id)).map(u =>
      <button key={u.id} type="button" onClick={() => onChange(value.filter(id => id !== u.id))} aria-label={`Remove ${u.name}`} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm">
        {u.name}<X className="h-3.5 w-3.5" />
      </button>)}</div>}
    <Input aria-label="Search users" placeholder="Search by name or email" value={search} onChange={e => setSearch(e.target.value)} />
    <div className="max-h-48 overflow-y-auto rounded-xl border border-border">
      {matches.slice(0, 50).map(u => <label key={u.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover">
        <input type="checkbox" aria-label={`Select ${u.name} (${u.email ?? u.upn})`} checked={value.includes(u.id)} onChange={e => onChange(e.target.checked ? [...value, u.id] : value.filter(id => id !== u.id))} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
        <span className="min-w-0 text-sm"><span className="block truncate">{u.name}{u.disabled && " (disabled)"}</span><span className="block truncate text-xs text-muted">{u.email ?? u.upn}</span></span>
      </label>)}
      {!matches.length && <p className="px-3 py-2 text-sm text-muted">{users.length ? "No matching users." : "Users appear after sign-in or when an account is added."}</p>}
    </div>
    {matches.length > 50 && <p className="text-xs text-muted">Search to narrow the list.</p>}
  </div>;
}

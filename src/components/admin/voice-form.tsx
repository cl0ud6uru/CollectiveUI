"use client";
import { useState, useTransition } from "react";
import { saveVoiceSettings } from "@/app/admin/voice-actions";
import type { VoiceSettings } from "@/lib/voice/policy";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { Card } from "./ui";

export function VoiceForm({ initial, providers }: { initial: VoiceSettings; providers: { id: string; name: string }[] }) {
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState("");
  return <Card className="mt-6"><h2 className="text-sm font-medium">Voice & avatar</h2>
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); setNotice(""); start(async () => {
      try { await saveVoiceSettings(value); setNotice("Voice settings saved."); }
      catch (error) { setNotice(error instanceof Error ? error.message : "Could not save settings."); }
    }); }}>
      <p className="text-sm text-muted">GPT-Live provides speech for native and Hermes bots. Their existing models, memory, tools and approvals handle requests. Voice transcripts are saved in chat. OpenAI voice and avatar reactions have separate API charges.</p>
      <Field label="OpenAI voice connection"><Select value={value.providerAppId ?? ""} disabled={pending} onChange={e => setValue({ ...value, providerAppId: e.target.value || null })}>
        <option value="">Use the chat’s OpenAI connection when available</option>
        {value.providerAppId && !providers.some(p => p.id === value.providerAppId) && <option value={value.providerAppId}>Unavailable connection</option>}
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select></Field>
      <p className="text-xs text-muted">For Hermes or other providers, select an OpenAI API connection. Users must also have access to this connection.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.reactions} disabled={pending} onChange={e => setValue({ ...value, reactions: e.target.checked })} /> Use Decisions for avatar reactions</label>
      <Field label="Blender avatar GLB path"><input className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" placeholder="/avatars/bot.glb" value={value.avatarUrl ?? ""} disabled={pending} onChange={e => setValue({ ...value, avatarUrl: e.target.value || null })} /></Field>
      <p className="text-xs text-muted">Export a GLB into public/avatars. Leave blank to use the animated placeholder.</p>
      <Button disabled={pending} type="submit">{pending ? "Saving…" : "Save voice settings"}</Button>
      {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
    </form>
  </Card>;
}

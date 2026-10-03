"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { saveBranding } from "@/app/admin/actions";
import { AvatarPicker } from "@/components/bots/avatar-picker";
import { BrandMark, PortalMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { BrandingInput, LOGIN_DESCRIPTION, LOGIN_HEADLINE, LOGO_MAX_BYTES, LOGO_TYPES } from "@/lib/branding/shared";
import type { CatalogPet } from "@/lib/pets/shared";
import type { BrandingSettings, LoginPetSettings } from "@/lib/settings";
import { StartTargetSelect } from "@/components/start-target-select";
import { LoginPetForm } from "./login-pet-form";
import { Card } from "./ui";

export function BrandingForm({ branding, initialLogoUrl, apps, bots, loginPet, petCatalog }: { branding: BrandingSettings; initialLogoUrl: string | null; apps: { id: string; name: string }[]; bots: { id: string; name: string }[]; loginPet: LoginPetSettings; petCatalog: CatalogPet[] }) {
  const router = useRouter();
  const [b, setB] = useState(branding);
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  function message(error: boolean, text: string) {
    setNotice({ error, text });
    if (error) toast.error(text);
  }
  function changeLogo(file: File | null) {
    if (file && (!LOGO_TYPES.includes(file.type) || !file.size || file.size > LOGO_MAX_BYTES)) {
      message(true, "Choose a PNG, JPEG, or WebP image, 2 MB or smaller.");
      return;
    }
    start(async () => {
      setNotice(null);
      try {
        const response = await fetch("/api/admin/branding/logo", file ? { method: "POST", headers: { "Content-Type": file.type }, body: file } : { method: "DELETE" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Logo update failed");
        setLogoUrl(result.logoUrl);
        message(false, file ? "Logo saved. It is now visible on the sign-in page and in the sidebar." : "Logo removed. The fallback icon is now in use.");
        router.refresh();
      } catch (err) {
        message(true, err instanceof Error ? err.message : "Logo update failed. Please try again.");
      }
    });
  }
  return (
    <Card className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-medium">Branding</h2><p className="mt-1 text-sm text-muted">Make this space your own. Your name, logo, sign-in companion, and sign-in introduction are public.</p></div>
        <a href="/login?preview=1" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-lg text-sm underline underline-offset-4 focus-visible:outline-2">View sign-in page <ExternalLink className="h-3.5 w-3.5" /><span className="sr-only"> (opens in a new tab)</span></a>
      </div>
      <div className="flex flex-wrap items-center gap-5 rounded-xl border border-border bg-sidebar p-4">
        <BrandMark logoUrl={logoUrl} logoEmoji={b.logoEmoji} className="h-16 w-16 rounded-xl bg-surface p-2 text-3xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium">Organization logo</p>
          <p id="logo-hint" className="text-xs text-muted">PNG, JPEG, or WebP · up to 2 MB and 2048 × 2048 pixels. Static images only.</p>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Organization logo" aria-describedby="logo-hint" disabled={pending} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) changeLogo(file); }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={pending} onClick={() => fileInput.current?.click()} className="focus-visible:outline-2"><ImagePlus className="h-4 w-4" />{logoUrl ? "Replace logo" : "Upload logo"}</Button>
            {logoUrl && <Button variant="ghost" disabled={pending} onClick={() => changeLogo(null)} className="focus-visible:outline-2"><Trash2 className="h-4 w-4" />Remove logo</Button>}
          </div>
          <p className="text-xs text-muted">Logo changes save immediately.</p>
        </div>
      </div>
      <LoginPetForm initial={loginPet} catalog={petCatalog} />
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault();
        const parsed = BrandingInput.safeParse(b);
        if (!parsed.success) { message(true, parsed.error.issues[0].message); return; }
        start(async () => {
          try { await saveBranding(parsed.data); message(false, "Branding saved."); router.refresh(); }
          catch { message(true, "Branding could not be saved. Please try again."); }
        });
      }}>
        <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
          <div><Label htmlFor="brand-name">Portal name</Label><Input id="brand-name" required maxLength={60} value={b.appName} onChange={(e) => setB({ ...b, appName: e.target.value })} /></div>
          <div><Label>Fallback icon</Label><div className="flex items-center gap-2"><AvatarPicker value={b.logoEmoji} onChange={(v) => setB({ ...b, logoEmoji: v })} className="h-9 w-9" size={36} reset={{ label: "Portal mark", preview: <PortalMark className="h-9 w-9" /> }} /><span className="text-xs text-muted">Shown when there&apos;s no logo.</span></div></div>
        </div>
        <div><Label htmlFor="brand-welcome">Chat welcome text</Label><Input id="brand-welcome" maxLength={200} value={b.welcomeText} onChange={(e) => setB({ ...b, welcomeText: e.target.value })} /></div>
        <div><Label htmlFor="brand-headline">Sign-in headline</Label><Input id="brand-headline" maxLength={100} placeholder={LOGIN_HEADLINE} value={b.loginHeadline ?? ""} onChange={(e) => setB({ ...b, loginHeadline: e.target.value })} /></div>
        <div><Label htmlFor="brand-description">Sign-in introduction</Label><Textarea id="brand-description" rows={3} maxLength={240} placeholder={LOGIN_DESCRIPTION} value={b.loginDescription ?? ""} onChange={(e) => setB({ ...b, loginDescription: e.target.value })} /><p className="mt-1 text-xs text-muted">Leave the headline or introduction empty to use the default.</p></div>
        <div><Label htmlFor="brand-default-start">Start new chats with</Label><StartTargetSelect id="brand-default-start" value={b} apps={apps} bots={bots} botsLabel="Shared bots" emptyLabel="First available model" onChange={(next) => setB({ ...b, defaultAppId: next.defaultAppId ?? undefined, defaultBotId: next.defaultBotId ?? undefined })} /><p className="mt-1 text-xs text-muted">Used when a person has no personal choice and the default coordinator is off. Only bots shared with everyone are listed; a chosen bot starts a fresh chat.</p></div>
        <Button type="submit" disabled={pending} className="focus-visible:outline-2">{pending ? "Saving…" : "Save branding"}</Button>
      </form>
      {notice && <p role={notice.error ? "alert" : "status"} className={`text-sm ${notice.error ? "text-danger" : "text-muted"}`}>{notice.text}</p>}
    </Card>
  );
}

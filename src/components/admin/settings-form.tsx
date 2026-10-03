"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveLimits } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import type { CatalogPet } from "@/lib/pets/shared";
import type { BrandingSettings, LimitsSettings, LoginPetSettings } from "@/lib/settings";
import { BrandingForm } from "./branding-form";
import { Card } from "./ui";

export function SettingsForm({ branding, initialLogoUrl, limits, apps, bots, loginPet, petCatalog }: { initialLogoUrl: string | null; branding: BrandingSettings; limits: LimitsSettings; apps: { id: string; name: string }[]; bots: { id: string; name: string }[]; loginPet: LoginPetSettings; petCatalog: CatalogPet[] }) {
  const router = useRouter();
  const [l, setL] = useState(limits);
  const [pending, start] = useTransition();
  const save = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
        toast.success("Saved");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  return (
    <div className="space-y-6">
      <BrandingForm branding={branding} initialLogoUrl={initialLogoUrl} apps={apps} bots={bots} loginPet={loginPet} petCatalog={petCatalog} />
      <Card className="space-y-4">
        <h2 className="font-medium">Uploads</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max file size (MB)">
            <Input type="number" value={l.uploadMaxMb} onChange={(e) => setL({ ...l, uploadMaxMb: Number(e.target.value) })} />
          </Field>
          <Field label="Max attachments per message">
            <Input type="number" value={l.maxAttachmentsPerMessage} onChange={(e) => setL({ ...l, maxAttachmentsPerMessage: Number(e.target.value) })} />
          </Field>
        </div>
        <Button disabled={pending} onClick={() => save(() => saveLimits(l))}>
          Save limits
        </Button>
      </Card>
    </div>
  );
}

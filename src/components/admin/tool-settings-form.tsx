"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveToolSettings } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Card } from "./ui";

type Initial = {
  disabledTools: string[];
  enforcedApproval: string[];
  fetchAllowlist: string[];
  webSearch: { provider: "none" | "searxng" | "brave" | "bing"; url?: string; hasKey: boolean };
  maxStepsCap: number;
  botCreation: "everyone" | "groups" | "admins";
  utilityAppId?: string;
  embeddingAppId?: string;
};

export function ToolSettingsForm({
  initial,
  tools,
  utilityApps,
  embeddingApps,
}: {
  initial: Initial;
  tools: { key: string; label: string }[];
  /** Apps that may be used for background work (company credentials only). */
  utilityApps: { id: string; name: string }[];
  embeddingApps: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [enforced, setEnforced] = useState(initial.enforcedApproval.join("\n"));
  const [allow, setAllow] = useState(initial.fetchAllowlist.join("\n"));
  const [pending, start] = useTransition();
  const lines = (v: string) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <h2 className="font-medium">Bot creation</h2>
        <Field label="Who can create bots">
          <Select aria-label="Who can create bots" value={s.botCreation} onChange={(e) => setS({ ...s, botCreation: e.target.value as Initial["botCreation"] })}>
            <option value="everyone">Everyone</option>
            <option value="groups">Members of groups with &quot;can create bots&quot;</option>
            <option value="admins">Admins only</option>
          </Select>
        </Field>
        <Field label="Max tool steps per run (cap)">
          <Input type="number" min={1} max={100} value={s.maxStepsCap} onChange={(e) => setS({ ...s, maxStepsCap: Number(e.target.value) })} className="w-32" />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">Tools</h2>
        <div>
          <div className="mb-1.5 text-sm font-medium">Enabled tools</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {tools.map((t) => (
              <label key={t.key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={!s.disabledTools.includes(t.key)}
                  onChange={(e) =>
                    setS({ ...s, disabledTools: e.target.checked ? s.disabledTools.filter((x) => x !== t.key) : [...s.disabledTools, t.key] })
                  }
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>
        <Field
          label="Always require approval"
          hint="Tool names or groups (one per line), e.g. m365_send_mail, fetch_url, mcp:<serverId>. Users cannot 'always allow' these."
        >
          <Textarea rows={4} value={enforced} onChange={(e) => setEnforced(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Web page allowlist" hint="Domains the fetch tool may read (one per line). Empty = any public site; private networks are always blocked unless listed.">
          <Textarea rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} className="font-mono" placeholder={"intranet.corp.com\nlearn.microsoft.com"} />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">Web search</h2>
        <Field label="Provider">
          <Select aria-label="Web search provider" value={s.webSearch.provider} onChange={(e) => setS({ ...s, webSearch: { ...s.webSearch, provider: e.target.value as Initial["webSearch"]["provider"] } })}>
            <option value="none">Disabled</option>
            <option value="searxng">SearXNG (self-hosted)</option>
            <option value="brave">Brave Search API</option>
            <option value="bing">Bing Web Search API</option>
          </Select>
        </Field>
        {s.webSearch.provider === "searxng" && (
          <Field label="SearXNG URL">
            <Input value={s.webSearch.url ?? ""} onChange={(e) => setS({ ...s, webSearch: { ...s.webSearch, url: e.target.value } })} placeholder="http://searxng:8080" />
          </Field>
        )}
        {(s.webSearch.provider === "brave" || s.webSearch.provider === "bing") && (
          <Field label="API key" hint={s.webSearch.hasKey ? "A key is stored; leave blank to keep it." : undefined}>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </Field>
        )}
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">Background models</h2>
        <Field label="Utility model" hint="Used for chat titles, memory extraction and drafting bots/skills. With no selection, uses the chat’s model when it supports background work with organization credentials. Hermes is not eligible.">
          <Select aria-label="Utility model" value={s.utilityAppId ?? ""} onChange={(e) => setS({ ...s, utilityAppId: e.target.value || undefined })}>
            <option value="">Same as the conversation</option>
            {s.utilityAppId && !utilityApps.some((a) => a.id === s.utilityAppId) && <option value={s.utilityAppId}>(unavailable connection — choose another)</option>}
            {utilityApps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Embedding connection" hint="Semantic search for memory and knowledge files. Without it, keyword search is used.">
          <Select aria-label="Embedding connection" value={s.embeddingAppId ?? ""} onChange={(e) => setS({ ...s, embeddingAppId: e.target.value || undefined })}>
            <option value="">None (keyword search)</option>
            {s.embeddingAppId && !embeddingApps.some((a) => a.id === s.embeddingAppId) && (
              <option value={s.embeddingAppId}>(unavailable connection — choose another)</option>
            )}
            {embeddingApps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await saveToolSettings({
                disabledTools: s.disabledTools,
                enforcedApproval: lines(enforced),
                fetchAllowlist: lines(allow),
                webSearch: { provider: s.webSearch.provider, url: s.webSearch.url, apiKey: apiKey || undefined },
                maxStepsCap: s.maxStepsCap,
                botCreation: s.botCreation,
                utilityAppId: s.utilityAppId,
                embeddingAppId: s.embeddingAppId,
              });
              toast.success("Saved");
              router.refresh();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Save failed");
            }
          })
        }
      >
        Save changes
      </Button>
    </div>
  );
}

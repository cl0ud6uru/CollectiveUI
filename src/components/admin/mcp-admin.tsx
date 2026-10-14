"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { revokeServiceBotGrant } from "@/app/(chat)/bots/actions";
import { toast } from "sonner";
import { Copy, Download, Loader2, Plug, Plus, Trash2 } from "lucide-react";
import {
  acceptMcpToolChanges,
  deleteMcpServer,
  importMcpServers,
  previewMcpImport,
  rotateMcpIdentitySecret,
  saveMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  type McpImportPreview,
} from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { McpServerStatus, McpToolPolicy, McpTrust } from "@/lib/mcp/kinds";
import { formatAdminTimestamp } from "@/lib/admin/timestamp";
import { GroupPicker } from "./group-picker";
import { Badge, Table, Td } from "./ui";

type ToolView = { name: string; description: string; readOnly: boolean; destructive: boolean };

export type McpServerView = {
  id: string;
  name: string;
  description: string | null;
  url: string;
  transport: "http" | "sse";
  hasHeaders: boolean;
  isPublic: boolean;
  groupIds: string[];
  status: McpServerStatus;
  trust: McpTrust;
  identityHeader: string | null;
  hasIdentitySecret: boolean;
  resultBudgetKb: number;
  timeoutSec: number;
  tools: ToolView[];
  toolPolicy: McpToolPolicy;
  drift: { hash: string; detectedAt: string; added: ToolView[]; changed: ToolView[]; removed: string[] } | null;
  serverInfo: { name?: string; version?: string } | null;
  lastTestedAt: string | null;
  lastError: string | null;
  authorizedBots?: { grantId: string; botId: string; name: string; revision: number; tool: string; effect: string; approval: boolean; needsReview: boolean }[];
};

const STATUS: Record<McpServerStatus, { label: string; tone: "default" | "green" | "red" | "amber" }> = {
  draft: { label: "draft", tone: "default" },
  enabled: { label: "enabled", tone: "green" },
  needs_review: { label: "needs review", tone: "amber" },
  disabled: { label: "disabled", tone: "red" },
};

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function serverInput(s: Partial<McpServerView>, identity: boolean, headers: string) {
  return {
    id: s.id,
    name: s.name ?? "",
    description: s.description ?? "",
    url: s.url ?? "",
    transport: s.transport ?? "http",
    headers,
    isPublic: s.isPublic ?? true,
    groupIds: s.groupIds ?? [],
    trust: s.trust ?? "untrusted",
    identity,
    identityHeader: s.identityHeader ?? undefined,
    resultBudgetKb: s.resultBudgetKb ?? 64,
    timeoutSec: s.timeoutSec ?? 60,
    toolPolicy: s.toolPolicy ?? {},
  };
}

function ToolBadges({ t }: { t: ToolView }) {
  return (
    <>
      {t.readOnly && <Badge tone="green">read-only</Badge>}
      {t.destructive && <Badge tone="red">destructive</Badge>}
    </>
  );
}

/** A new identity secret, shown once: the admin configures it on the MCP server. */
function SecretOnce({ secret, header }: { secret: string; header: string }) {
  return (
    <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p>
        Configure this secret on the MCP server to verify the <code className="font-mono">{header}</code> header. It is shown only once.
      </p>
      <div className="flex items-center gap-2">
        <code aria-label="Identity secret" className="min-w-0 flex-1 break-all rounded-lg bg-bg px-2 py-1 font-mono text-xs">
          {secret}
        </code>
        <button
          type="button"
          aria-label="Copy secret"
          className="rounded-lg p-1.5 text-muted hover:bg-hover"
          onClick={() => navigator.clipboard?.writeText(secret).then(() => toast.success("Copied"))}
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted">See docs/mcp-identity.md for how to verify it (HS256 JWT, 60-second lifetime, audience = the server URL).</p>
    </div>
  );
}

function ServerDialog({
  server,
  servers,
  groups,
  onClose,
}: {
  server: Partial<McpServerView> | null;
  servers: McpServerView[];
  groups: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [s, setS] = useState<Partial<McpServerView>>(server ?? {});
  const [headers, setHeaders] = useState("");
  const [identity, setIdentity] = useState(!!server?.identityHeader);
  const [directMode, setDirectMode] = useState(server?.isPublic !== false ? "everyone" : server?.groupIds?.length ? "groups" : "none");
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [savedInput, setSavedInput] = useState(() => serverInput(server ?? {}, !!server?.identityHeader, ""));
  const [testFeedback, setTestFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const input = serverInput(s, identity, headers);
  const dirty = JSON.stringify(input) !== JSON.stringify(savedInput);
  // A refresh updates test results without replacing the draft being edited.
  const current = servers.find((row) => row.id === s.id) ?? s;
  const policy = s.toolPolicy ?? {};
  const setPolicy = (name: string, patch: McpToolPolicy[string]) => setS({ ...s, toolPolicy: { ...policy, [name]: { ...policy[name], ...patch } } });
  const saved = !!s.id;

  const testSaved = async () => {
    if (!s.id || dirty || pending || busy) return;
    setBusy("Test");
    setTestFeedback(null);
    try {
      const result = await testMcpServer(s.id);
      setTestFeedback(!result.ok
        ? { error: true, message: `Connection failed: ${result.error}` }
        : { error: false, message: result.result === "drift"
          ? "The saved server's tool list changed. Review the changes below."
          : `Saved configuration tested successfully. ${result.tools.length} ${result.tools.length === 1 ? "tool" : "tools"} available.` });
      router.refresh();
    } catch (err) {
      setTestFeedback({ error: true, message: errorText(err, "Connection test failed. Try again.") });
    } finally {
      setBusy(null);
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toast.error(errorText(err, `${label} failed`));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    start(async () => {
      try {
        const r = await saveMcpServer(input);
        toast.success(saved ? "Saved" : "Saved as a draft. Test it, then enable it.");
        router.refresh();
        if (r.identitySecret) {
          // Keep the dialog open so the secret can be copied; later saves edit this server.
          setSecret(r.identitySecret);
          const next = { ...s, id: r.id, hasIdentitySecret: true };
          setS(next);
          setSavedInput(serverInput(next, identity, ""));
          setHeaders("");
        } else onClose();
      } catch (err) {
        toast.error(errorText(err, "Save failed"));
      }
    });

  return (
    <Dialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={saved ? `Edit ${s.name}` : "Add MCP server"} className="max-w-2xl">
        <div className="space-y-4">
          {secret && <SecretOnce secret={secret} header={s.identityHeader || "X-Portal-Identity"} />}
          <Field label="Name" hint="Used as the tool prefix, e.g. jira__create_issue">
            <Input aria-label="Name" value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Jira" />
          </Field>
          <Field label="Description">
            <Input aria-label="Description" value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="URL" hint={saved ? "Changing the URL or transport makes this a draft again." : undefined}>
              <Input aria-label="URL" value={s.url ?? ""} onChange={(e) => setS({ ...s, url: e.target.value })} placeholder="https://mcp.internal/jira/mcp" />
            </Field>
            <Field label="Transport">
              <Select aria-label="Transport" value={s.transport ?? "http"} onChange={(e) => setS({ ...s, transport: e.target.value as McpServerView["transport"] })}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </Select>
            </Field>
          </div>
          <Field label="Headers (JSON)" hint={s.hasHeaders ? "Headers are stored (encrypted). Leave blank to keep them." : 'e.g. {"Authorization": "Bearer …"}'}>
            <Textarea aria-label="Headers (JSON)" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} className="font-mono" />
          </Field>

          <div className="space-y-2 rounded-xl border border-border p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Send each person&apos;s identity
                <span className="block text-xs text-muted">
                  A signed, 60-second token saying who is chatting, next to the headers above, so the server can apply its own permissions.
                </span>
              </span>
              <Switch aria-label="Send identity" checked={identity} onCheckedChange={setIdentity} />
            </label>
            {identity && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Field label="Header name">
                    <Input
                      aria-label="Identity header"
                      value={s.identityHeader ?? ""}
                      placeholder="X-Portal-Identity"
                      onChange={(e) => setS({ ...s, identityHeader: e.target.value })}
                      className="font-mono"
                    />
                  </Field>
                </div>
                {saved && s.hasIdentitySecret && !!server?.identityHeader && (
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() =>
                      confirm("Issue a new secret? The current one stops working immediately.") &&
                      run("Rotate", async () => {
                        const r = await rotateMcpIdentitySecret(s.id!);
                        setSecret(r.identitySecret);
                      })
                    }
                  >
                    New secret
                  </Button>
                )}
              </div>
            )}
            {identity && !s.hasIdentitySecret && <p className="text-xs text-muted">A secret is created when you save, and shown once.</p>}
          </div>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
            <span>
              Trusted server
              <span className="block text-xs text-muted">
                With &quot;Ask unless read-only&quot; approvals, tools this server marks read-only run without asking. Leave off for servers you don&apos;t
                control.
              </span>
            </span>
            <Switch aria-label="Trusted server" checked={s.trust === "trusted"} onCheckedChange={(v) => setS({ ...s, trust: v ? "trusted" : "untrusted" })} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Result limit (KB)" hint="Longer tool results are cut, with a note to the model.">
              <Input
                aria-label="Result limit (KB)"
                type="number"
                min={1}
                max={1024}
                value={s.resultBudgetKb ?? 64}
                onChange={(e) => setS({ ...s, resultBudgetKb: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (seconds)">
              <Input
                aria-label="Timeout (seconds)"
                type="number"
                min={1}
                max={600}
                value={s.timeoutSec ?? 60}
                onChange={(e) => setS({ ...s, timeoutSec: Number(e.target.value) })}
              />
            </Field>
          </div>

          <Field label="Direct access" hint="Who may attach this connector to their own bots. This does not grant editing rights or automatically add it to plain model chats.">
            <Select aria-label="Direct access" value={directMode} onChange={(e) => {
              setDirectMode(e.target.value);
              setS({ ...s, isPublic: e.target.value === "everyone", groupIds: e.target.value === "groups" ? s.groupIds ?? [] : [] });
            }}>
              <option value="everyone">Everyone in the organization</option>
              <option value="groups">Selected groups</option>
              <option value="none">No ordinary users — admins only</option>
            </Select>
          </Field>
          {directMode === "groups" && <GroupPicker groups={groups} value={s.groupIds ?? []} onChange={(v) => setS({ ...s, groupIds: v })} />}
          <div className="space-y-2 rounded-xl border border-border p-3">
            <div className="text-sm font-medium">Authorized bots</div>
            <p className="text-xs text-muted">Separate grants let a published, admin-managed bot use exact tools for its audience without direct connector access. Changing this connector requires reviewing and republishing its service grants.</p>
            {(s.authorizedBots ?? []).map((g) => <div key={g.grantId} className="flex items-center justify-between gap-2 text-xs">
              <span><Link className="underline" href={`/bots/${g.botId}/edit`}>{g.name}</Link> · revision {g.revision} · {g.tool} · {g.effect} · {g.approval ? "always asks" : "reviewed read"}
                {g.needsReview && <span className="text-warn"> · needs review</span>}</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("Revoke", async () => {
                await revokeServiceBotGrant(g.grantId); router.refresh(); onClose();
              })}>Revoke</Button>
            </div>)}
            {!s.authorizedBots?.length && <p className="text-xs text-muted">No bot grants. Choose “Admin-managed service bot” in the <Link href="/bots/new" className="underline">bot editor</Link>, then review and publish its capabilities.</p>}
          </div>

          {saved && (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">Tools</span> <Badge tone={STATUS[current.status ?? "draft"].tone}>{STATUS[current.status ?? "draft"].label}</Badge>
                  <div className="text-xs text-muted">
                    {current.lastTestedAt ? `Last checked ${formatAdminTimestamp(current.lastTestedAt)}` : "Not tested yet"}
                    {current.serverInfo?.name ? ` · ${current.serverInfo.name}${current.serverInfo.version ? ` ${current.serverInfo.version}` : ""}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={!!busy || pending || dirty}
                    onClick={testSaved}
                  >
                    {busy === "Test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Test saved server
                  </Button>
                  {current.status === "draft" || current.status === "disabled" ? (
                    <Button
                      disabled={!!busy || pending || dirty || !current.tools?.length}
                      onClick={() =>
                        run("Enable", async () => {
                          await setMcpServerEnabled(s.id!, true);
                          toast.success("Enabled");
                          router.refresh();
                          onClose();
                        })
                      }
                    >
                      Enable
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={!!busy || pending || dirty}
                      onClick={() =>
                        run("Disable", async () => {
                          await setMcpServerEnabled(s.id!, false);
                          toast.success("Disabled");
                          router.refresh();
                          onClose();
                        })
                      }
                    >
                      Disable
                    </Button>
                  )}
                </div>
              </div>
              {dirty && <p role="status" className="text-sm text-muted">Save your changes before testing or changing this server&apos;s status.</p>}
              {testFeedback && !dirty && <p role={testFeedback.error ? "alert" : "status"} className={`text-sm ${testFeedback.error ? "text-danger" : "text-muted"}`}>{testFeedback.message}</p>}
              {current.lastError && !testFeedback && <p className="text-xs text-danger">Last check failed: {current.lastError}</p>}

              {current.drift && (
                <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p className="font-medium">The server&apos;s tool list changed ({formatAdminTimestamp(current.drift.detectedAt)})</p>
                  <p className="text-xs text-muted">Changed and removed tools are hidden from bots, and new tools aren&apos;t offered, until you accept.</p>
                  {current.drift.added.map((t) => (
                    <div key={`a-${t.name}`} className="text-xs">
                      <Badge tone="blue">new</Badge> <span className="font-mono">{t.name}</span> <ToolBadges t={t} />
                      <div className="text-muted">{t.description}</div>
                    </div>
                  ))}
                  {current.drift.changed.map((t) => (
                    <div key={`c-${t.name}`} className="text-xs">
                      <Badge tone="amber">changed</Badge> <span className="font-mono">{t.name}</span> <ToolBadges t={t} />
                      <div className="text-muted">{t.description}</div>
                    </div>
                  ))}
                  {current.drift.removed.map((n) => (
                    <div key={`r-${n}`} className="text-xs">
                      <Badge tone="red">removed</Badge> <span className="font-mono">{n}</span>
                    </div>
                  ))}
                  <Button
                    disabled={!!busy || pending || dirty}
                    onClick={() =>
                      run("Accept", async () => {
                        await acceptMcpToolChanges(s.id!, current.drift!.hash);
                        toast.success("Changes accepted");
                        router.refresh();
                        onClose();
                      })
                    }
                  >
                    Accept changes
                  </Button>
                </div>
              )}

              {!!current.tools?.length && (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {current.tools.map((t) => (
                    <div key={t.name} className="flex items-start gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs">{t.name}</span> <ToolBadges t={t} />
                        </div>
                        {t.description && <div className="line-clamp-2 text-xs text-muted">{t.description}</div>}
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        Ask first
                        <Switch
                          aria-label={`Require approval for ${t.name}`}
                          checked={!!policy[t.name]?.requireApproval}
                          onCheckedChange={(v) => setPolicy(t.name, { requireApproval: v })}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        On
                        <Switch aria-label={`Use ${t.name}`} checked={policy[t.name]?.enabled !== false} onCheckedChange={(v) => setPolicy(t.name, { enabled: v })} />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {!!current.tools?.length && <p className="text-xs text-muted">&quot;Ask first&quot; always asks, even if someone chose &quot;Always allow&quot;. Save to apply.</p>}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {secret ? "Done" : "Cancel"}
            </Button>
            <Button disabled={pending || !!busy || !s.name || !s.url} onClick={save}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const IMPORT_EXAMPLE = `{
  "mcpServers": {
    "jira": { "type": "http", "url": "https://mcp.internal/jira/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}`;

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const [pending, start] = useTransition();
  const importable = preview?.candidates.filter((c) => !c.problem).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Import MCP servers" className="max-w-2xl">
        <div className="space-y-4">
          <Field
            label="Client config (JSON)"
            hint="Paste the mcpServers section from Claude Desktop, Claude Code (.mcp.json), Cursor, Windsurf or VS Code. Remote servers are added as drafts; local (stdio) ones can't run in the portal."
          >
            <Textarea
              aria-label="Client config (JSON)"
              rows={8}
              value={text}
              placeholder={IMPORT_EXAMPLE}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              className="font-mono text-xs"
            />
          </Field>
          {preview && (
            <div className="space-y-2 text-sm">
              {preview.candidates.map((c) => (
                <div key={c.name} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge tone={c.problem ? "red" : "green"}>{c.problem ? "skipped" : c.transport === "sse" ? "SSE" : "HTTP"}</Badge>
                    <span className="font-mono text-xs text-muted">{c.url}</span>
                  </div>
                  {c.headerNames.length > 0 && <div className="text-xs text-muted">Headers: {c.headerNames.join(", ")} (stored encrypted)</div>}
                  {c.problem && <div className="text-xs text-danger">{c.problem}</div>}
                  {c.warnings.map((w) => (
                    <div key={w} className="text-xs text-amber-700 dark:text-amber-300">
                      {w}
                    </div>
                  ))}
                </div>
              ))}
              {preview.rejected.map((r) => (
                <div key={r.name} className="rounded-lg border border-border px-3 py-2">
                  <span className="font-medium">{r.name}</span> <Badge tone="red">can&apos;t import</Badge>
                  <div className="text-xs text-muted">{r.reason}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {!preview ? (
              <Button
                disabled={pending || !text.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await previewMcpImport(text);
                    if (r.ok) setPreview(r.preview);
                    else toast.error(r.error);
                  })
                }
              >
                Check
              </Button>
            ) : (
              <Button
                disabled={pending || !importable}
                onClick={() =>
                  start(async () => {
                    try {
                      const r = await importMcpServers(text);
                      toast.success(`Imported ${r.created} server(s) as drafts. Test each one, then enable it.`);
                      router.refresh();
                      onClose();
                    } catch (err) {
                      toast.error(errorText(err, "Import failed"));
                    }
                  })
                }
              >
                Import {importable} as drafts
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function McpAdmin({ servers, groups }: { servers: McpServerView[]; groups: { id: string; name: string }[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<Partial<McpServerView> | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: "Test" | "Delete" } | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const runRowAction = async (server: McpServerView, action: "Test" | "Delete") => {
    if (pendingAction) return;
    if (action === "Delete" && !confirm(`Delete ${server.name}?`)) return;
    setPendingAction({ id: server.id, action });
    setFeedback(null);
    try {
      let message: string;
      if (action === "Test") {
        const result = await testMcpServer(server.id);
        if (!result.ok) throw new Error(`Connection failed: ${result.error}`);
        message = result.result === "drift"
          ? `${server.name}: the tool list changed. Open it to review.`
          : `${result.tools.length} tools: ${result.tools.slice(0, 8).join(", ")}${result.tools.length > 8 ? "…" : ""}`;
      } else {
        await deleteMcpServer(server.id);
        message = `${server.name} deleted.`;
      }
      setFeedback({ error: false, message });
      toast.success(message);
      router.refresh();
    } catch (err) {
      const message = errorText(err, `${action} failed. Try again.`);
      setFeedback({ error: true, message });
      toast.error(message);
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <div>
      <div className="mb-4 flex justify-end gap-2">
        <Button variant="outline" disabled={!!pendingAction} onClick={() => setImporting(true)}>
          <Download className="h-4 w-4" /> Import
        </Button>
        <Button disabled={!!pendingAction} onClick={() => setEdit({ transport: "http", isPublic: true, trust: "untrusted", resultBudgetKb: 64, timeoutSec: 60 })}>
          <Plus className="h-4 w-4" /> Add server
        </Button>
      </div>
      {feedback && <p role={feedback.error ? "alert" : "status"} className={`mb-4 text-sm ${feedback.error ? "text-danger" : "text-muted"}`}>{feedback.message}</p>}
      <Table head={["Name", "URL", "Access", "Status", ""]}>
        {servers.map((s) => (
          <tr key={s.id} className="hover:bg-hover/50">
            <Td>
              <button type="button" className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Edit ${s.name}`} disabled={!!pendingAction} onClick={() => setEdit(s)}>{s.name}</button>
              <div className="text-xs text-muted">{s.description}</div>
            </Td>
            <Td className="font-mono text-xs text-muted">{s.url}</Td>
            <Td>{s.isPublic ? <Badge tone="green">everyone</Badge> : <Badge tone="amber">{s.groupIds.length} group(s)</Badge>}</Td>
            <Td>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                {s.trust === "trusted" && <Badge tone="blue">trusted</Badge>}
                {s.identityHeader && <Badge>identity</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-muted">{s.lastError ? <span className="text-danger">check failed</span> : s.tools.length ? `${s.tools.length} tools` : "not tested"}</div>
            </Td>
            <Td className="whitespace-nowrap">
              <button
                type="button"
                disabled={!!pendingAction}
                onClick={() => runRowAction(s, "Test")}
                className="rounded-lg p-1.5 text-muted hover:bg-hover disabled:opacity-50"
                aria-label={`Test ${s.name}`}
              >
                {pendingAction?.id === s.id && pendingAction.action === "Test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              </button>
              <button
                type="button"
                disabled={!!pendingAction}
                onClick={() => runRowAction(s, "Delete")}
                className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger disabled:opacity-50"
                aria-label={`Delete ${s.name}`}
              >
                {pendingAction?.id === s.id && pendingAction.action === "Delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </Td>
          </tr>
        ))}
        {!servers.length && (
          <tr>
            <Td colSpan={5} className="py-8 text-center text-muted">
              No MCP servers yet.
            </Td>
          </tr>
        )}
      </Table>
      <ServerDialog key={edit?.id ?? (edit ? "new" : "none")} server={edit} servers={servers} groups={groups} onClose={() => setEdit(null)} />
      {importing && <ImportDialog open onClose={() => setImporting(false)} />}
    </div>
  );
}

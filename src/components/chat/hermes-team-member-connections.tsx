"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type TeamMemberConnectionMetadata = {
  status: "connection_needed" | "connected" | "expired" | "revoked";
  revision: number;
  id?: string;
  expiresAt?: string;
};
export type TeamMemberConnection = TeamMemberConnectionMetadata & {
  capabilityId: string;
  name: string;
  available: boolean;
  reason?: string;
  setup: { kind: "unavailable" } | { kind: "verified_action"; actionId: string };
};

export const teamConnectionStatusLabels: Record<TeamMemberConnectionMetadata["status"], string> = {
  connection_needed: "Connection needed", connected: "Connection saved", expired: "Connection expired", revoked: "Disconnected",
};

export async function disconnectTeamMemberConnection(row: TeamMemberConnectionMetadata & { id: string }): Promise<TeamMemberConnectionMetadata> {
  const response = await fetch(`/api/hermes-team/member-connections/${encodeURIComponent(row.id)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: row.revision }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "Your connection was not confirmed disconnected. Refresh before trying again."), { status: response.status });
  if (result.status !== "revoked" || !Number.isInteger(result.revision)) throw new Error("Your connection was not confirmed disconnected. Refresh before trying again.");
  return { id: row.id, status: "revoked", revision: result.revision };
}

/** Only server-selected required capabilities; no endpoint, account chooser or credential fields. */
export function HermesTeamMemberConnections({ botId, contextKey, supportedAuthActions = [], onConnect }: {
  botId: string;
  contextKey: string;
  /** Empty until an account-specific authentication action has been verified. */
  supportedAuthActions?: readonly string[];
  onConnect?: (input: { capabilityId: string; actionId: string }) => Promise<void>;
}) {
  return <MemberConnections key={`${botId}:${contextKey}`} botId={botId} supportedAuthActions={supportedAuthActions} onConnect={onConnect} />;
}

function MemberConnections({ botId, supportedAuthActions, onConnect }: Omit<Parameters<typeof HermesTeamMemberConnections>[0], "contextKey"> & { supportedAuthActions: readonly string[] }) {
  const [rows, setRows] = useState<TeamMemberConnection[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const held = useRef(false);
  const epoch = useRef(0);
  const reload = () => { setRows(null); setAttempt(value => value + 1); };
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const readEpoch = epoch.current;
      try {
        const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/team/connections`, { cache: "no-store", signal: abort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Your connection status could not be checked.");
        if (!Array.isArray(result.connections)) throw new Error("Your connection status was not confirmed. Try again.");
        if (!abort.signal.aborted && readEpoch === epoch.current) { setRows(result.connections); setError(""); }
      } catch (err) {
        if (!abort.signal.aborted && readEpoch === epoch.current) { setRows(null); setError(err instanceof Error ? err.message : "Your connection status could not be checked."); }
      } finally { if (!abort.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 30000 : 5000); }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [botId, attempt]);

  async function disconnect(row: TeamMemberConnection) {
    if (held.current || !row.id || row.revision < 1 || row.status === "revoked") return;
    held.current = true; setPending(row.capabilityId); setError(""); setNotice("");
    epoch.current++;
    try {
      // Owner-only disconnect remains usable after this bot's access or capability is removed.
      const result = await disconnectTeamMemberConnection({ ...row, id: row.id });
      epoch.current++;
      setRows(current => current?.map(item => item.id === row.id ? { ...item, ...result } : item) ?? null);
      setNotice("Saved access disconnected. Your chat history is preserved. This does not revoke access at the outside service.");
    } catch (err) {
      epoch.current++;
      if (err instanceof Error && "status" in err && (err.status === 403 || err.status === 409)) setRows(null);
      setError(err instanceof Error ? err.message : "Your connection was not confirmed disconnected. Refresh before trying again.");
    }
    finally { held.current = false; setPending(null); }
  }
  async function connect(row: TeamMemberConnection) {
    if (held.current || !row.available || row.setup.kind !== "verified_action" || !supportedAuthActions.includes(row.setup.actionId) || !onConnect) return;
    held.current = true; setPending(row.capabilityId); setError(""); setNotice("");
    try { await onConnect({ capabilityId: row.capabilityId, actionId: row.setup.actionId }); reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "Your connection setup was not confirmed."); }
    finally { held.current = false; setPending(null); }
  }
  if (rows?.length === 0 && !error) return null;
  return <section aria-label="Your Team Bot connections" className="mx-auto min-w-0 w-full max-w-3xl px-4 py-2 text-sm">
    <div className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Your connections</h3><Button size="sm" variant="outline" disabled={pending !== null} onClick={reload}>Refresh connections</Button></div>
      {rows === null && !error && <p role="status" className="text-xs text-muted">Checking your required connections…</p>}
      {rows?.map(row => {
        const canConnect = row.available && row.setup.kind === "verified_action" && supportedAuthActions.includes(row.setup.actionId) && !!onConnect;
        return <div key={row.capabilityId} className="min-w-0 space-y-2 wrap-anywhere border-t border-border pt-3" role="region" aria-label={`Connection for ${row.name}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{row.name}</span><span className="text-xs text-muted">{teamConnectionStatusLabels[row.status]}</span></div>
          <p className="text-xs text-muted">This feature requires your own account. Your saved access belongs to you in both chat modes.</p>
          {row.expiresAt && row.status !== "revoked" && <p className="text-xs text-muted">Expires <time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString()}</time></p>}
          {!canConnect && <p className="text-xs text-muted">{row.reason || "Connecting your own account is awaiting verification."} Ask your administrator to verify this account connection before setup is available.</p>}
          {row.status === "connected" && <p className="text-xs text-muted">Saved access does not confirm that this feature or model access is available.</p>}
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={pending !== null || !canConnect} onClick={() => void connect(row)}>{row.revision > 0 ? "Reconnect" : "Connect"}</Button>
            {!!row.id && row.revision > 0 && row.status !== "revoked" && <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void disconnect(row)}>Disconnect saved access</Button>}</div>
        </div>;
      })}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    </div>
  </section>;
}

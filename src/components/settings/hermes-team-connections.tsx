"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { disconnectTeamMemberConnection, teamConnectionStatusLabels, type TeamMemberConnectionMetadata } from "@/components/chat/hermes-team-member-connections";

export type SavedTeamConnection = TeamMemberConnectionMetadata & { id: string; name: string };
export type SavedTeamConnectionPage = { connections: SavedTeamConnection[]; nextCursor: string | null };

/** Current actor's retained account cleanup, independent of Team audience or feature admission. */
export function HermesTeamSavedConnections({ initial }: { initial: SavedTeamConnectionPage }) {
  const [rows, setRows] = useState(initial.connections);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const held = useRef(false), epoch = useRef(0), readAbort = useRef<AbortController | null>(null);

  async function load(next?: string) {
    readAbort.current?.abort();
    const abort = new AbortController(); readAbort.current = abort;
    const readEpoch = epoch.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/hermes-team/member-connections${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, { cache: "no-store", signal: abort.signal });
      const result = await response.json();
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && !abort.signal.aborted && readEpoch === epoch.current) { setRows([]); setCursor(null); }
        throw new Error(result.error ?? "Your saved connection list could not be checked.");
      }
      if (!Array.isArray(result.connections) || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new Error("Your saved connection list was not confirmed. Try again.");
      if (!abort.signal.aborted && readEpoch === epoch.current) {
        setRows(current => next ? [...new Map([...current, ...result.connections].map(row => [row.id, row])).values()] : result.connections);
        setCursor(result.nextCursor);
      }
    } catch (err) { if (!abort.signal.aborted && readEpoch === epoch.current) setError(err instanceof Error ? err.message : "Your saved connection list could not be checked."); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  // The authenticated Settings page supplies one initial page, keyed to the current actor/session.
  useEffect(() => () => readAbort.current?.abort(), []);

  async function disconnect(row: SavedTeamConnection) {
    if (held.current || row.status === "revoked") return;
    held.current = true; epoch.current++; readAbort.current?.abort(); setLoading(false); setPending(row.id); setError(""); setNotice("");
    try {
      const result = await disconnectTeamMemberConnection(row); epoch.current++;
      setRows(current => current.map(item => item.id === row.id ? { ...item, ...result } : item));
      setNotice("Saved access disconnected. Your chat history is preserved. This does not revoke access at the outside service.");
    } catch (err) {
      epoch.current++;
      if (err instanceof Error && "status" in err && (err.status === 401 || err.status === 403 || err.status === 409)) { setRows([]); setCursor(null); }
      setError(err instanceof Error ? err.message : "Your connection was not confirmed disconnected. Refresh before trying again.");
    } finally { held.current = false; setPending(null); }
  }
  return <section aria-label="Saved Team Bot connections" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Team Bot connections</h3><Button size="sm" variant="outline" disabled={loading || pending !== null} onClick={() => void load()}>Refresh saved connections</Button></div>
    <p className="text-xs text-muted">Manage your saved access, including accounts used by bots you can no longer open. Reconnect from a bot that requires your account when a supported connection is available.</p>
    {loading && <p role="status" className="text-xs text-muted">Checking your saved connections…</p>}
    {rows.map(row => <div key={row.id} className="min-w-0 space-y-2 wrap-anywhere rounded-xl border border-border p-3 text-sm" role="region" aria-label={`Saved connection for ${row.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{row.name}</span><span className="text-xs text-muted">{teamConnectionStatusLabels[row.status]}</span></div>
      {row.expiresAt && row.status !== "revoked" && <p className="text-xs text-muted">Expires <time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString()}</time></p>}
      {row.status === "connected" && <p className="text-xs text-muted">Saved access does not confirm service or model availability.</p>}
      {row.status !== "revoked" && <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void disconnect(row)}>Disconnect saved access</Button>}
    </div>)}
    {!loading && !rows.length && !error && <p className="text-sm text-muted">No saved Team Bot connections.</p>}
    {cursor && <Button size="sm" variant="outline" disabled={loading || pending !== null} onClick={() => void load(cursor)}>Show more saved connections</Button>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
  </section>;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, RefreshCw, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AGENT_BROWSER_STALE_FRAME_MS, MAX_AGENT_BROWSER_FRAME_BYTES, type AgentBrowserState, type AgentBrowserStatus } from "@/lib/agent-browser/contracts";
import styles from "./agent-browser-viewer.module.css";

type FramePayload = { sequence: number; capturedAt: string; contentType: "image/jpeg"; width: number; height: number; data: string };
const statusUrl = (conversationId: string) => `/api/agent-browser/status?${new URLSearchParams({ conversationId })}`;
const streamUrl = (conversationId: string) => `/api/agent-browser/stream?${new URLSearchParams({ conversationId })}`;

function validStatus(value: unknown): value is AgentBrowserStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<AgentBrowserStatus>;
  return status.viewOnly === true && ["active", "idle", "disconnected"].includes(status.state ?? "") &&
    (status.lastFrameAt === null || (typeof status.lastFrameAt === "string" && Number.isFinite(Date.parse(status.lastFrameAt))));
}

function frameBlob(payload: FramePayload): Blob | null {
  if (!payload || payload.contentType !== "image/jpeg" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
      !Number.isInteger(payload.width) || payload.width < 1 || payload.width > 1920 ||
      !Number.isInteger(payload.height) || payload.height < 1 || payload.height > 1080 ||
      typeof payload.capturedAt !== "string" || !Number.isFinite(Date.parse(payload.capturedAt)) ||
      typeof payload.data !== "string" || payload.data.length > Math.ceil(MAX_AGENT_BROWSER_FRAME_BYTES * 4 / 3) + 8 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) return null;
  try {
    const binary = atob(payload.data);
    if (binary.length < 4 || binary.length > MAX_AGENT_BROWSER_FRAME_BYTES) return null;
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    return new Blob([bytes], { type: "image/jpeg" });
  } catch { return null; }
}

async function readStatus(conversationId: string, signal: AbortSignal): Promise<AgentBrowserStatus> {
  const response = await fetch(statusUrl(conversationId), { cache: "no-store", signal });
  if (!response.ok) throw new Error("Browser view unavailable.");
  const status: unknown = await response.json();
  if (!validStatus(status)) throw new Error("Browser view unavailable.");
  return status;
}

/** Read-only consumer for the same browser session used by the admitted agent run. */
export function AgentBrowserViewer({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  const [statusSnapshot, setStatusSnapshot] = useState<{ conversationId: string; value: AgentBrowserStatus } | null>(null);
  const status = statusSnapshot?.conversationId === conversationId ? statusSnapshot.value : null;
  const [errorSnapshot, setErrorSnapshot] = useState<{ conversationId: string; message: string } | null>(null);
  const error = errorSnapshot?.conversationId === conversationId ? errorSnapshot.message : "";
  const [frame, setFrame] = useState<{ conversationId: string; url: string } | null>(null);
  const [width, setWidth] = useState(560);
  const [mobile, setMobile] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const frameUrlRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);

  const revokeFrameUrl = useCallback(() => {
    if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
    frameUrlRef.current = null; sequenceRef.current = 0;
  }, []);
  const clearFrame = useCallback(() => {
    revokeFrameUrl(); setFrame(null);
  }, [revokeFrameUrl]);

  useEffect(() => {
    const layout = matchMedia("(min-width: 1100px)");
    const update = () => setMobile(!layout.matches);
    update(); layout.addEventListener("change", update);
    return () => layout.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await readStatus(conversationId, controller.signal);
        if (stopped || controller.signal.aborted) return;
        setStatusSnapshot({ conversationId, value: next }); setErrorSnapshot(null);
        if (next.state === "disconnected") clearFrame();
      } catch {
        if (!stopped && !controller.signal.aborted) { setStatusSnapshot(null); setErrorSnapshot({ conversationId, message: "Browser view unavailable." }); clearFrame(); }
      }
      if (!stopped && !controller.signal.aborted) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, conversationId, refreshVersion, clearFrame]);

  // A closed view or a new conversation invalidates its pixels immediately; no previous chat frame can flash here.
  useEffect(() => { if (!open || frame?.conversationId !== conversationId) revokeFrameUrl(); }, [open, conversationId, frame?.conversationId, revokeFrameUrl]);

  // Clear a frozen picture as soon as its capture goes stale, even if the status poll is delayed.
  useEffect(() => {
    if (!open || !status?.lastFrameAt || clock - Date.parse(status.lastFrameAt) <= AGENT_BROWSER_STALE_FRAME_MS) return;
    revokeFrameUrl();
  }, [open, status?.lastFrameAt, clock, revokeFrameUrl]);

  const canSubscribe = !!status && (status.state !== "disconnected" || status.lastFrameAt !== null);
  useEffect(() => {
    if (!open || !canSubscribe) return;
    let stopped = false;
    let retry: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const parseFrame = (raw: string) => {
      if (raw.length > 720_000) return;
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      const frame = payload as FramePayload;
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= sequenceRef.current) return;
      const blob = frameBlob(frame);
      if (!blob) return;
      sequenceRef.current = frame.sequence;
      const nextUrl = URL.createObjectURL(blob);
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = nextUrl; setFrame({ conversationId, url: nextUrl });
      setStatusSnapshot(previous => ({ conversationId, value: { state: previous?.conversationId === conversationId && previous.value.state === "idle" ? "idle" : "active", viewOnly: true, lastFrameAt: frame.capturedAt } }));
      setErrorSnapshot(null);
    };
    const scheduleRetry = (delay: number) => {
      if (!stopped && !controller.signal.aborted) retry = window.setTimeout(connect, delay);
    };
    const connect = async () => {
      // A reconnect may resolve a newer run whose provider sequence restarted. Drop the old image and accept its first frame.
      sequenceRef.current = 0; clearFrame();
      try {
        const response = await fetch(streamUrl(conversationId), { cache: "no-store", signal: controller.signal, headers: { Accept: "text/event-stream" } });
        if (!response.ok || !response.body) throw new Error("Browser stream unavailable.");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "", event = "", data: string[] = [];
        const dispatch = () => {
          const raw = data.join("\n");
          if (event === "frame") parseFrame(raw);
          else if (event === "disconnected") { setStatusSnapshot({ conversationId, value: { state: "disconnected", viewOnly: true, lastFrameAt: null } }); clearFrame(); }
          event = ""; data = [];
        };
        for (;;) {
          const result = await reader.read();
          if (result.done || stopped || controller.signal.aborted) break;
          pending += decoder.decode(result.value, { stream: true });
          if (pending.length > 750_000) { pending = ""; event = ""; data = []; continue; }
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
            if (!line) dispatch();
            else if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            newline = pending.indexOf("\n");
          }
        }
        if (!stopped && !controller.signal.aborted) scheduleRetry(600);
      } catch {
        if (!stopped && !controller.signal.aborted) {
          setErrorSnapshot({ conversationId, message: "Live browser frames are temporarily unavailable." });
          scheduleRetry(2500);
        }
      }
    };
    void connect();
    return () => {
      stopped = true; controller.abort(); if (retry) clearTimeout(retry);
      void reader?.cancel().catch(() => {});
    };
  }, [open, conversationId, canSubscribe, clearFrame]);

  useEffect(() => () => clearFrame(), [clearFrame]);
  useEffect(() => {
    if (!open || mobile) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    panelRef.current?.focus(); window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, mobile, onClose]);

  const capturedAt = status?.lastFrameAt ? Date.parse(status.lastFrameAt) : NaN;
  const frameFresh = Number.isFinite(capturedAt) && clock - capturedAt <= AGENT_BROWSER_STALE_FRAME_MS;
  const viewState: AgentBrowserState | null = !status ? null : (status.lastFrameAt && !frameFresh) ? "disconnected" : status.state;
  const visibleFrameUrl = frame?.conversationId === conversationId && frameUrlRef.current === frame.url && frameFresh && viewState !== "disconnected" ? frame.url : null;
  const stateLabel = !status ? "Checking connection" : viewState === "active" ? frameFresh ? "Agent browser active" : "Waiting for the first frame" : viewState === "idle" ? "Agent idle · browser attached" : "Disconnected";
  const content = <>
    <header className={styles.header}>
      <div className={styles.heading}><Eye size={16} aria-hidden /><strong>Agent browser</strong><span>VIEW ONLY</span></div>
      <button className={styles.iconButton} aria-label="Close browser view" onClick={onClose}><X size={15} /></button>
    </header>
    <div className={styles.status} role="status" aria-live="polite">
      <span className={cn(styles.dot, viewState === "disconnected" && styles.offline, viewState === "idle" && styles.idle)} />
      <span>{stateLabel}</span>
      <button className={styles.iconButton} aria-label="Refresh browser status" onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={13} /></button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <main className={styles.stage} aria-label="Read-only agent browser frames">
      {visibleFrameUrl ? <>
        {/* A Blob URL is produced from the bounded, authenticated JPEG stream and cannot use next/image loaders. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.frame} src={visibleFrameUrl} alt="Current frame from the agent’s browser session" />
      </> :
        <div className={styles.empty}>
          {!status && <Loader2 size={24} className="animate-spin" aria-hidden />}
          <div className={styles.emptyIcon}><Eye size={22} aria-hidden /></div>
          <strong>{viewState === "disconnected" ? "No live browser frame" : "Waiting for browser frame"}</strong>
          <p>{viewState === "disconnected" ? "This chat has no connected agent browser session." : "The agent’s page will appear here when its browser session sends a fresh frame."}</p>
        </div>}
    </main>
    <footer className={styles.footer}><span>Read only · no mouse or keyboard controls</span><span>{frameFresh && status?.lastFrameAt ? `Captured ${new Date(status.lastFrameAt).toLocaleTimeString()}` : "Private to your account"}</span></footer>
  </>;

  if (mobile) return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent title="Agent browser" description="A read-only view of the agent's browser session" hideClose className={styles.mobileDialog}><div className={styles.mobilePanel}>{content}</div></DialogContent></Dialog>;
  return <aside ref={panelRef} hidden={!open} tabIndex={-1} aria-label="Agent browser view" className={styles.panel} style={{ width }}>
    <div role="separator" aria-label="Resize browser view panel" aria-orientation="vertical" aria-valuemin={420} aria-valuemax={900} aria-valuenow={width} tabIndex={0} className={styles.resize}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(previous => Math.max(420, Math.min(900, previous + (event.key === "ArrowLeft" ? 24 : -24)))); } }}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(420, Math.min(900, window.innerWidth - event.clientX))); }} />
    {content}
  </aside>;
}

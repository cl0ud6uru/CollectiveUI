"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronUp, Expand, Loader2, LockKeyhole, Monitor, RefreshCw, Shrink, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import styles from "./computer-viewer.module.css";

type ComputerStatus = {
  available: boolean;
  state: "running" | "stopped" | "unavailable";
  control: "agent" | "you" | "other";
  paused: boolean;
  lastFrameAt: string | null;
  width: number;
  height: number;
  reason?: string;
};
type FramePayload = { sequence: number; capturedAt: string; contentType: "image/jpeg"; width: number; height: number; data: string };
type ComputerInput =
  | { kind: "click"; x: number; y: number; button: "left" | "right" | "middle" }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; direction: "up" | "down"; amount: number };

const FRESH_MS = 8_000;
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_TYPE_TEXT = 4_000;
const query = (conversationId: string) => new URLSearchParams({ conversationId }).toString();
const statusUrl = (conversationId: string) => `/api/computer/status?${query(conversationId)}`;
const streamUrl = (conversationId: string) => `/api/computer/stream?${query(conversationId)}`;
const safeTypeText = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\n\t]/g, " ")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").slice(0, MAX_TYPE_TEXT);

function validStatus(value: unknown): value is ComputerStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<ComputerStatus>;
  return typeof status.available === "boolean" && ["running", "stopped", "unavailable"].includes(status.state ?? "") &&
    ["agent", "you", "other"].includes(status.control ?? "") && typeof status.paused === "boolean" &&
    (status.lastFrameAt === null || (typeof status.lastFrameAt === "string" && Number.isFinite(Date.parse(status.lastFrameAt)))) &&
    Number.isInteger(status.width) && Number.isInteger(status.height) &&
    (status.reason === undefined || typeof status.reason === "string");
}

function validFrame(value: unknown): value is FramePayload {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<FramePayload>;
  return Number.isSafeInteger(frame.sequence) && (frame.sequence ?? 0) > 0 && frame.contentType === "image/jpeg" &&
    Number.isInteger(frame.width) && (frame.width ?? 0) > 0 && (frame.width ?? 0) <= 1920 &&
    Number.isInteger(frame.height) && (frame.height ?? 0) > 0 && (frame.height ?? 0) <= 1080 &&
    typeof frame.capturedAt === "string" && Number.isFinite(Date.parse(frame.capturedAt)) &&
    typeof frame.data === "string" && frame.data.length <= Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 8 && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data);
}

function dataUrl(frame: FramePayload) {
  if (frame.data.length < 8) return null;
  try {
    const binary = atob(frame.data);
    if (binary.length > MAX_FRAME_BYTES || binary.length < 4) return null;
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  } catch { return null; }
}

async function getStatus(conversationId: string, signal: AbortSignal) {
  const response = await fetch(statusUrl(conversationId), { cache: "no-store", signal });
  if (!response.ok) throw new Error("Computer status is temporarily unavailable.");
  const value: unknown = await response.json();
  if (!validStatus(value)) throw new Error("Computer status is temporarily unavailable.");
  return value;
}

/** Full desktop viewer for the caller-owned Codex computer. Closing it never stops the agent run. */
export function ComputerViewer({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  return <ComputerViewerSession key={conversationId} open={open} onClose={onClose} conversationId={conversationId} />;
}

function ComputerViewerSession({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  const [statusScope, setStatusScope] = useState<{ conversationId: string; value: ComputerStatus } | null>(null);
  const status = statusScope?.conversationId === conversationId ? statusScope.value : null;
  const [frame, setFrame] = useState<{ conversationId: string; url: string; sequence: number; capturedAt: string; width: number; height: number } | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busyAction, setBusyAction] = useState<"takeover" | "release" | null>(null);
  const [text, setText] = useState("");
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panelWidth, setPanelWidth] = useState(600);
  const [refreshKey, setRefreshKey] = useState(0);
  const stageRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const controlRef = useRef<{ conversationId: string; control: ComputerStatus["control"] }>({ conversationId, control: "agent" });
  const receivedFrameConversationRef = useRef<string | null>(null);

  const clearFrame = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    sequenceRef.current = 0;
    setFrame(null);
  }, []);
  const setStatus = useCallback((next: ComputerStatus) => {
    controlRef.current = { conversationId, control: next.control };
    setStatusScope({ conversationId, value: next });
  }, [conversationId]);
  const markControlLost = useCallback((message: string) => {
    controlRef.current = { conversationId, control: "other" };
    setStatusScope(previous => previous?.conversationId === conversationId
      ? { conversationId, value: { ...previous.value, control: "other", paused: true, reason: "Computer control expired. Take over again to continue." } }
      : previous);
    setError(message);
  }, [conversationId]);
  const postInput = useCallback(async (input: ComputerInput) => {
    if (!open || controlRef.current.conversationId !== conversationId || controlRef.current.control !== "you") return false;
    const safeInput: ComputerInput = input.kind === "type" ? { ...input, text: safeTypeText(input.text) } : input;
    if (safeInput.kind === "type" && !safeInput.text) return false;
    try {
      const response = await fetch("/api/computer/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, input: safeInput }),
      });
      if (!response.ok) throw new Error("Computer control expired. Take control again to continue.");
      return true;
    } catch (cause) {
      markControlLost(cause instanceof Error ? cause.message : "Computer control expired. Take control again to continue.");
      void getStatus(conversationId, new AbortController().signal).then(setStatus).catch(() => {});
      return false;
    }
  }, [conversationId, markControlLost, open, setStatus]);

  const control = useCallback(async (action: "takeover" | "release" | "heartbeat") => {
    setBusyAction(action === "heartbeat" ? null : action);
    try {
      const response = await fetch("/api/computer/control", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, action }),
      });
      if (!response.ok) throw new Error(action === "takeover" ? "Could not take control. Refresh computer status and try again." : "Computer control was lost. The lease has expired.");
      const value: unknown = await response.json();
      if (!validStatus(value)) throw new Error("Computer control response was invalid.");
      setStatus(value); setError("");
      return value;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Computer control is unavailable.";
      if (action === "heartbeat" || action === "release") markControlLost(message);
      else setError(message);
      return null;
    } finally { if (action !== "heartbeat") setBusyAction(null); }
  }, [conversationId, markControlLost, setStatus]);

  const close = useCallback(() => { onClose(); }, [onClose]);

  useEffect(() => {
    const layout = matchMedia("(min-width: 1100px)");
    const update = () => setMobile(!layout.matches);
    update(); layout.addEventListener("change", update);
    return () => layout.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await getStatus(conversationId, controller.signal);
        if (stopped || controller.signal.aborted) return;
        setStatus(next); setError("");
        if (!next.available || next.state !== "running") clearFrame();
      } catch {
        if (!stopped && !controller.signal.aborted) { setError("Computer status is temporarily unavailable."); clearFrame(); }
      }
      if (!stopped && !controller.signal.aborted) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, conversationId, refreshKey, setStatus, clearFrame]);

  useEffect(() => {
    if (open && frame?.conversationId === conversationId) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    sequenceRef.current = 0;
  }, [open, conversationId, frame?.conversationId]);

  const capturedAt = frame?.conversationId === conversationId ? Date.parse(frame.capturedAt) : NaN;
  const frameFresh = Number.isFinite(capturedAt) && clock - capturedAt <= FRESH_MS;
  useEffect(() => {
    if (!frame || frameFresh || objectUrlRef.current !== frame.url) return;
    URL.revokeObjectURL(frame.url);
    objectUrlRef.current = null;
  }, [frame, frameFresh]);

  const canStream = !!status && status.available && status.state === "running";
  useEffect(() => {
    if (!open || !canStream) return;
    let stopped = false;
    let retry: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const parseFrame = (raw: string) => {
      if (raw.length > 720_000) return;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return; }
      if (!validFrame(value) || value.sequence <= sequenceRef.current) return;
      const url = dataUrl(value);
      if (!url) return;
      sequenceRef.current = value.sequence;
      receivedFrameConversationRef.current = conversationId;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      setFrame({ conversationId, url, sequence: value.sequence, capturedAt: value.capturedAt, width: value.width, height: value.height });
      setStatusScope(previous => {
        if (!previous || previous.conversationId !== conversationId) return previous;
        const next = { ...previous.value, lastFrameAt: value.capturedAt };
        controlRef.current = { conversationId, control: next.control };
        return { conversationId, value: next };
      });
      setConnecting(false); setError("");
    };
    const scheduleRetry = (delay: number) => { if (!stopped && !controller.signal.aborted) retry = window.setTimeout(connect, delay); };
    const connect = async () => {
      setConnecting(true); clearFrame(); sequenceRef.current = 0;
      try {
        const response = await fetch(streamUrl(conversationId), { cache: "no-store", signal: controller.signal, headers: { Accept: "text/event-stream" } });
        if (!response.ok || !response.body) throw new Error("Computer stream unavailable.");
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = "", event = "", data: string[] = [];
        const dispatch = () => {
          const raw = data.join("\n");
          if (event === "frame") parseFrame(raw);
          else if (event === "disconnected") { setConnecting(true); clearFrame(); }
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
        if (!stopped && !controller.signal.aborted) scheduleRetry(700);
      } catch {
        if (!stopped && !controller.signal.aborted) { setConnecting(true); setError("Reconnecting to the computer…"); scheduleRetry(2000); }
      }
    };
    void connect();
    return () => { stopped = true; controller.abort(); if (retry) clearTimeout(retry); void reader?.cancel().catch(() => {}); };
  }, [open, conversationId, canStream, clearFrame]);

  useEffect(() => {
    if (!open || status?.control !== "you") return;
    const timer = window.setInterval(() => { void control("heartbeat"); }, 10_000);
    return () => window.clearInterval(timer);
  }, [open, status?.control, control]);

  useEffect(() => () => clearFrame(), [clearFrame]);

  const canInteract = open && status?.available === true && status.state === "running" && status.control === "you" && frameFresh && !!frame;
  const stateLabel = !status || connecting && canStream ? (receivedFrameConversationRef.current === conversationId ? "Reconnecting" : "Connecting") :
    !status.available || status.state === "stopped" || status.state === "unavailable" ? "Stopped" : frameFresh ? "Live" : connecting ? "Reconnecting" : "Connecting";

  const mapClick = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (!canInteract) return;
    const image = imageRef.current;
    if (!image) return;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / (frame?.width ?? 1), rect.height / (frame?.height ?? 1));
    const renderedWidth = (frame?.width ?? 1) * scale;
    const renderedHeight = (frame?.height ?? 1) * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = Math.floor((event.clientX - left) / scale), y = Math.floor((event.clientY - top) / scale);
    if (x < 0 || y < 0 || x >= (frame?.width ?? 0) || y >= (frame?.height ?? 0)) return;
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    event.preventDefault(); void postInput({ kind: "click", x, y, button });
  }, [canInteract, frame?.height, frame?.width, postInput]);

  const handleStageKey = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!canInteract) return;
    const allowed = new Set(["Enter", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    let key: string | null = allowed.has(event.key) ? event.key : null;
    if (event.ctrlKey && ["a", "c"].includes(event.key.toLowerCase())) key = `Control+${event.key.toLowerCase()}`;
    if (key) { event.preventDefault(); void postInput({ kind: "key", key }); }
    // Ctrl+V is handled by the stage's paste event so only plain clipboard text is sent.
    if (event.ctrlKey && event.key.toLowerCase() === "v") event.preventDefault();
  }, [canInteract, close, postInput]);

  const pasteText = useCallback((event: React.ClipboardEvent<HTMLElement>) => {
    if (!canInteract) return;
    const pasted = safeTypeText(event.clipboardData.getData("text/plain"));
    if (!pasted) return;
    event.preventDefault(); void postInput({ kind: "type", text: pasted });
  }, [canInteract, postInput]);

  const sendText = async () => {
    const safeText = safeTypeText(text);
    if (!safeText || !canInteract) return;
    const sent = await postInput({ kind: "type", text: safeText });
    if (sent) setText("");
  };

  const content = <>
    <header className={styles.header}>
      <div className={styles.heading}><Monitor size={17} aria-hidden /><strong>Computer</strong><span className={styles.botName}>Codex</span></div>
      <div className={styles.headerActions}>
        {!mobile && <button className={styles.iconButton} aria-label={expanded ? "Collapse computer view" : "Expand computer view"} title={expanded ? "Collapse" : "Expand"} onClick={() => setExpanded(value => !value)}>{expanded ? <Shrink size={15} /> : <Expand size={15} />}</button>}
        <button className={styles.iconButton} aria-label="Close computer view" onClick={close}><X size={16} /></button>
      </div>
    </header>
    <div className={styles.status} role="status" aria-live="polite">
      <span className={cn(styles.dot, stateLabel === "Stopped" && styles.offline, stateLabel === "Reconnecting" && styles.reconnecting)} />
      <strong>{stateLabel}</strong><span className={styles.statusDetail}>{stateLabel === "Live" ? "Computer stream" : stateLabel === "Stopped" ? status?.reason ?? "No running computer session" : "Waiting for a fresh frame"}</span>
      <button className={styles.iconButton} aria-label="Refresh computer status" onClick={() => { setError(""); setRefreshKey(value => value + 1); }}><RefreshCw size={14} /></button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <main ref={stageRef} className={styles.stage} aria-label="Codex computer screen" tabIndex={canInteract ? 0 : -1} onKeyDown={handleStageKey} onPaste={pasteText} onContextMenu={event => { if (canInteract) event.preventDefault(); }}>
      {frameFresh && frame?.conversationId === conversationId && objectUrlRef.current === frame.url ? <>
        {/* The authenticated, bounded JPEG arrives as a Blob URL and is not compatible with next/image loaders. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imageRef} className={cn(styles.frame, canInteract && styles.interactive)} src={frame.url} data-frame-sequence={frame.sequence} alt={`Fresh computer frame captured ${new Date(frame.capturedAt).toLocaleTimeString()}`} onPointerDown={mapClick} />
      </> :
        <div className={styles.empty}>
          {stateLabel === "Connecting" && <Loader2 size={23} className="animate-spin" aria-hidden />}
          <div className={styles.emptyIcon}><Monitor size={22} aria-hidden /></div>
          <strong>{stateLabel === "Stopped" ? "Computer stopped" : stateLabel === "Reconnecting" ? "Reconnecting" : "Connecting to the computer"}</strong>
          <p>{status?.reason ?? (stateLabel === "Stopped" ? "This conversation has no running Codex computer session." : "The screen will appear when a fresh frame arrives.")}</p>
        </div>}
      {frameFresh && frame && <span className={styles.resolution}>{frame.width} × {frame.height}</span>}
    </main>
    <section className={styles.controls} aria-label="Computer controls">
      {status?.control === "you" ? <>
        <div className={styles.takeoverNotice}><LockKeyhole size={14} aria-hidden /><span>The agent is paused while you use its computer. Return control to let it continue. Closing the view leaves the agent paused until you return control.</span></div>
        <div className={styles.inputRow}>
          <label className={styles.textLabel} htmlFor="computer-type-text">Type text</label>
          <input id="computer-type-text" value={text} maxLength={MAX_TYPE_TEXT} autoComplete="off" spellCheck={false} placeholder="Type into the computer…" onChange={event => setText(safeTypeText(event.target.value))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void sendText(); } }} disabled={!canInteract} />
          <button className={styles.sendButton} onClick={() => void sendText()} disabled={!canInteract || !text}>Send</button>
        </div>
        <p className={styles.textHint}>Line breaks become spaces. Focus the screen to send Enter, Tab, and navigation keys.</p>
        <div className={styles.controlActions}>
          <div className={styles.scrollControl}><button className={styles.iconButton} aria-label="Scroll up" disabled={!canInteract} onClick={() => void postInput({ kind: "scroll", direction: "up", amount: 3 })}><ChevronUp size={15} /></button><button className={styles.iconButton} aria-label="Scroll down" disabled={!canInteract} onClick={() => void postInput({ kind: "scroll", direction: "down", amount: 3 })}><ChevronDown size={15} /></button><span>Scroll</span></div>
          <button className={styles.returnButton} disabled={busyAction !== null} onClick={() => void control("release")}><ArrowLeftRight size={14} /> Return control</button>
        </div>
      </> : <div className={styles.takeoverRow}>
        <span>{status?.control === "other" ? status.paused ? status.reason ?? "The agent is paused. Take over to use its computer." : status.reason ?? "Someone else has control." : "The agent has control of this computer."}</span>
        <button className={styles.takeoverButton} disabled={!status?.available || status.state !== "running" || busyAction !== null} onClick={() => void control("takeover")}>
          {busyAction === "takeover" ? <Loader2 size={14} className="animate-spin" /> : <LockKeyhole size={14} />} Take over
        </button>
      </div>}
    </section>
    <footer className={styles.footer}>
      <span>{status?.control === "you" ? canInteract ? "Click the screen, use the text field, or focus the screen for keyboard controls" : "Control is active · waiting for a fresh frame" : status?.control === "other" && status.paused ? "Closing the view leaves the agent paused until you return control." : "Read only · taking control pauses the agent"}</span>
      <span>{frameFresh && frame ? `Frame ${new Date(frame.capturedAt).toLocaleTimeString()}` : "No fresh frame"}</span>
    </footer>
  </>;

  if (mobile) return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}><DialogContent title="Computer" description="View and control the Codex computer" hideClose onCloseAutoFocus={event => { event.preventDefault(); }} className={styles.mobileDialog}><div className={styles.mobilePanel}>{content}</div></DialogContent></Dialog>;
  return <aside hidden={!open} aria-label="Computer viewer" className={cn(styles.panel, expanded && styles.expanded)} style={{ width: expanded ? undefined : panelWidth }}>
    {!expanded && <div role="separator" aria-label="Resize computer view panel" aria-orientation="vertical" aria-valuemin={440} aria-valuemax={920} aria-valuenow={panelWidth} tabIndex={0} className={styles.resize}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setPanelWidth(value => Math.max(440, Math.min(920, value + (event.key === "ArrowLeft" ? 24 : -24)))); } }}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPanelWidth(Math.max(440, Math.min(920, window.innerWidth - event.clientX))); }} />}
    {content}
  </aside>;
}

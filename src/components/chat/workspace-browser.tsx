"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Download, FileCode2, FileText, Folder, FolderOpen, Loader2, PanelRightClose, Play, RefreshCw, Search, Square, Terminal, Upload, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { WorkspaceBrowserStatus, WorkspaceFilePreview } from "@/lib/sandbox/browser";
import { appendTerminalOutput, terminalOmissionNotice, type CommandEvent, type TerminalOmissions } from "@/lib/chat/terminal-output";
import type { ListEntry } from "@/sandboxd/protocol/types";
import styles from "./workspace-browser.module.css";

type Listing = { entries: ListEntry[]; truncated: boolean };
type FileTab = { path: string; preview?: WorkspaceFilePreview; loading: boolean; error?: string };
type Command = { id: string; command: string; output: string; status: "running" | "done" | "error" | "stopped"; code?: number; detail?: string; clippedCharacters?: number; omissions?: TerminalOmissions };
export type WorkspaceCommandHistory = { id: string; command: string; output: string; running: boolean }[];

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const endpoint = (operation: string, path?: string) => `/api/workspace/browser?${new URLSearchParams({ operation, ...(path ? { path } : {}) })}`;
function tabKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The workspace could not be opened.");
  return data as T;
}

export function useWorkspaceAccess(enabled: boolean) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void request<WorkspaceBrowserStatus>(endpoint("status"), { signal: controller.signal })
      .then(status => { if (!controller.signal.aborted) setAllowed(status.allowed); }).catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return enabled && allowed;
}

/** A persistent owner's workspace, shared across their bot chats. It never takes a bot/ref/user id. */
export function WorkspaceBrowser({ open, onClose, onInsertPath, history = [], fileRequest }: {
  open: boolean; onClose: () => void; onInsertPath?: (path: string) => void; history?: WorkspaceCommandHistory; fileRequest?: { path: string; id: number };
}) {
  const [status, setStatus] = useState<WorkspaceBrowserStatus | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"files" | "terminal">("files");
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState("");
  const [commands, setCommands] = useState<Command[]>([]);
  const [running, setRunning] = useState(false);
  const [width, setWidth] = useState(600);
  const [mobile, setMobile] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const commandAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const terminalRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const opening = useRef(false);
  const filesGeneration = useRef(0);
  const currentTab = tabs.find(tab => tab.path === activePath);

  useEffect(() => {
    mounted.current = true;
    const query = matchMedia("(min-width: 1100px)");
    const update = () => setMobile(!query.matches);
    update(); query.addEventListener("change", update);
    return () => { mounted.current = false; query.removeEventListener("change", update); commandAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open || mobile) return;
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    panelRef.current?.focus();
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, mobile, onClose]);
  useEffect(() => {
    if (running || history.some(item => item.running)) terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [commands, history, running]);

  const loadDirectory = useCallback(async (path: string, fresh = false) => {
    const generation = filesGeneration.current;
    setLoadingDirs(previous => new Set(previous).add(path));
    try {
      const listing = await request<Listing>(endpoint("list", path));
      if (!mounted.current || generation !== filesGeneration.current) return;
      setListings(previous => fresh ? { [path]: listing } : { ...previous, [path]: listing });
    } catch (e) { if (mounted.current && generation === filesGeneration.current) setError(e instanceof Error ? e.message : "Could not load files."); }
    finally { if (mounted.current && generation === filesGeneration.current) setLoadingDirs(previous => { const next = new Set(previous); next.delete(path); return next; }); }
  }, []);

  const refresh = useCallback(async () => {
    if (opening.current) return;
    opening.current = true; setError("");
    try {
      const next = await request<WorkspaceBrowserStatus>(endpoint("status"));
      if (!mounted.current) return;
      setStatus(next);
      if (next.allowed && next.configured && next.state !== "unavailable") {
        filesGeneration.current++;
        setExpanded(new Set()); setLoadingDirs(new Set());
        await loadDirectory(".", true);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not open workspace."); }
    finally { opening.current = false; }
  }, [loadDirectory]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  // New bot file operations refresh the visible browser, without polling/waking an idle workspace.
  useEffect(() => {
    if (!open) return;
    const update = () => void refresh();
    window.addEventListener("workspace-files-changed", update);
    return () => window.removeEventListener("workspace-files-changed", update);
  }, [open, refresh]);

  const openFile = useCallback(async (path: string) => {
    setActivePath(path); setView("files"); setNotice("");
    setTabs(previous => previous.some(tab => tab.path === path) ? previous.map(tab => tab.path === path ? { ...tab, loading: true, error: undefined } : tab) : [...previous, { path, loading: true }]);
    try {
      const preview = await request<WorkspaceFilePreview>(endpoint("preview", path));
      if (mounted.current) setTabs(previous => previous.map(tab => tab.path === path ? { path, preview, loading: false } : tab));
    } catch (e) { if (mounted.current) setTabs(previous => previous.map(tab => tab.path === path ? { ...tab, loading: false, error: e instanceof Error ? e.message : "Could not open file." } : tab)); }
  }, []);
  useEffect(() => { if (open && fileRequest) void openFile(fileRequest.path); }, [open, fileRequest, openFile]);
  function closeFile(path: string) {
    const index = tabs.findIndex(tab => tab.path === path);
    const remaining = tabs.filter(tab => tab.path !== path);
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining[Math.min(index, remaining.length - 1)]?.path ?? null);
  }
  function toggleDirectory(path: string) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    if (!listings[path]) void loadDirectory(path);
  }
  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) { setError("Choose a file smaller than 10 MB."); return; }
    setUploading(true); setError("");
    const body = new FormData(); body.set("file", file); body.set("directory", ".");
    try {
      const result = await request<{ path: string }>("/api/workspace/upload", { method: "POST", body });
      if (!mounted.current) return;
      setNotice(`${file.name} uploaded. Existing files were kept.`);
      await refresh(); await openFile(result.path);
      setNotice(`${file.name} uploaded. Use its path in your chat.`);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not upload file."); }
    finally { if (mounted.current) setUploading(false); }
  }
  async function copyPath(path: string) {
    try { await navigator.clipboard.writeText(path); setNotice("File path copied."); }
    catch { setNotice(`File path: ${path}`); }
  }
  async function runCommand(event: React.FormEvent) {
    event.preventDefault();
    if (!command.trim() || running) return;
    const text = command.trim(), id = crypto.randomUUID();
    const controller = new AbortController(); commandAbort.current = controller;
    setCommands(previous => [...previous, { id, command: text, output: "", status: "running" }]);
    setCommand(""); setRunning(true); setError("");
    const patch = (value: Partial<Command>) => { if (mounted.current) setCommands(previous => previous.map(item => item.id === id ? { ...item, ...value } : item)); };
    let ended = false;
    try {
      const response = await fetch("/api/workspace/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: text, cwd: "." }), signal: controller.signal });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Could not run command."); }
      if (!response.body) throw new Error("The command stream is unavailable.");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
      const consume = (line: string) => {
        if (!line) return;
        const event = JSON.parse(line) as CommandEvent;
        if ((event.type === "output" || event.type === "gap") && mounted.current) setCommands(previous => previous.map(item => {
          if (item.id !== id) return item;
          if (event.type === "output") return { ...item, ...appendTerminalOutput(item.output, event.text ?? "", item.clippedCharacters) };
          const omissions = item.omissions ?? { dropped: { out: 0, err: 0 }, limited: { out: 0, err: 0 } };
          const key = event.source === "limit" ? "limited" : "dropped", stream = event.stream ?? "out", bytes = event.bytes ?? 0;
          const next = { ...omissions, [key]: { ...omissions[key], [stream]: omissions[key][stream] + bytes } };
          return { ...item, omissions: next, ...appendTerminalOutput(item.output, `\n[${bytes} bytes of ${stream === "out" ? "stdout" : "stderr"} omitted by ${event.source === "limit" ? "the workspace output limit" : "the workspace service"}]\n`, item.clippedCharacters) };
        }));
        if (event.type === "exit") { ended = true; patch({ status: event.code === 0 ? "done" : "error", code: event.code, omissions: { dropped: event.dropped ?? { out: 0, err: 0 }, limited: event.limited ?? { out: 0, err: 0 } }, detail: event.truncated && !event.dropped && !event.limited ? "Some command output was omitted." : event.reason !== "exit" && event.reason !== "exited" && event.reason !== "completed" ? event.reason : undefined }); }
        if (event.type === "error") { ended = true; patch({ status: "error", detail: event.text }); }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) { pending += decoder.decode(); if (pending.trim()) consume(pending); break; }
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!; lines.forEach(consume);
      }
      if (!ended) throw new Error("Connection ended before completion. Check the output before retrying.");
    } catch (e) { patch({ status: controller.signal.aborted ? "stopped" : "error", detail: controller.signal.aborted ? "Stop requested. The workspace is cancelling this command." : e instanceof Error ? e.message : "Command failed." }); }
    finally { commandAbort.current = null; if (mounted.current) { setRunning(false); void refresh(); } }
  }

  function directoryRows(path: string, depth = 0): React.ReactNode {
    return [...(listings[path]?.entries ?? [])].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.path.localeCompare(b.path)).map(entry => {
      const matches = !filter || entry.path.toLowerCase().includes(filter.toLowerCase());
      const dir = entry.type === "dir";
      if (!matches && !dir) return null;
      return <div key={entry.path}>
        <button className={cn(styles.fileRow, activePath === entry.path && styles.selected)} style={{ paddingLeft: 10 + depth * 12 }} title={entry.path} onClick={() => dir ? toggleDirectory(entry.path) : void openFile(entry.path)} aria-expanded={dir ? expanded.has(entry.path) : undefined}>
          {dir ? <><ChevronRight className={cn(styles.chevron, expanded.has(entry.path) && styles.expanded)} />{expanded.has(entry.path) ? <FolderOpen size={15} /> : <Folder size={15} />}</> : <FileText size={15} className={styles.fileIcon} />}
          <span>{baseName(entry.path)}</span>{loadingDirs.has(entry.path) && <Loader2 size={12} className="animate-spin" />}
        </button>
        {dir && expanded.has(entry.path) && directoryRows(entry.path, depth + 1)}
        {dir && expanded.has(entry.path) && listings[entry.path]?.entries.length === 0 && <p className={styles.emptyFolder}>Empty folder</p>}
        {dir && expanded.has(entry.path) && listings[entry.path]?.truncated && <p className={styles.emptyFolder}>Showing the first 500 entries.</p>}
      </div>;
    });
  }

  const ready = status?.allowed && status.configured && status.state !== "unavailable";
  const content = <>
    <header className={styles.header}>
      <div className={styles.title}><FolderOpen size={17} /><strong>Workspace</strong><span className={styles.private}>Yours</span></div>
      <button className={styles.iconButton} aria-label="Close workspace" title="Close workspace" onClick={onClose}><PanelRightClose size={18} /></button>
    </header>
    <div className={styles.nav}>
      <div role="tablist" aria-label="Workspace views" className={styles.viewTabs} onKeyDown={tabKeys}>
        <button id="workspace-files-tab" role="tab" tabIndex={view === "files" ? 0 : -1} aria-selected={view === "files"} aria-controls="workspace-files-view" className={cn(styles.viewTab, view === "files" && styles.activeView)} onClick={() => setView("files")}><FolderOpen size={15} />Files</button>
        <button id="workspace-terminal-tab" role="tab" tabIndex={view === "terminal" ? 0 : -1} aria-selected={view === "terminal"} aria-controls="workspace-terminal-view" className={cn(styles.viewTab, view === "terminal" && styles.activeView)} onClick={() => setView("terminal")}><Terminal size={15} />Terminal{running && <Loader2 size={12} className="animate-spin" />}</button>
      </div>
      <button className={styles.iconButton} aria-label="Refresh workspace" title="Refresh workspace" onClick={() => void refresh()} disabled={loadingDirs.has(".")}><RefreshCw size={15} className={cn(loadingDirs.has(".") && "animate-spin")} /></button>
    </div>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => void refresh()}>Retry</button></div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!status ? <div className={styles.empty}><Loader2 className="animate-spin" size={24} /><h3>Opening your workspace</h3></div> : !ready ? <div className={styles.empty}><FolderOpen size={30} /><h3>{!status.allowed ? "Workspace access is off" : !status.configured ? "Workspaces need setup" : "Workspace unavailable"}</h3><p>{!status.allowed ? "Ask your admin to enable workspace access for your account." : !status.configured ? "An admin can complete setup in Admin → Workspaces." : "The service could not be reached. Try refreshing."}</p></div> : view === "files" ? <div id="workspace-files-view" role="tabpanel" aria-labelledby="workspace-files-tab" className={styles.files}>
      <div className={styles.editor}>
        <div className={styles.documents} role="tablist" aria-label="Open files" onKeyDown={tabKeys}>
          {tabs.length ? tabs.map(tab => <div key={tab.path} className={cn(styles.document, activePath === tab.path && styles.activeDocument)}>
            <button role="tab" tabIndex={activePath === tab.path ? 0 : -1} aria-selected={activePath === tab.path} title={tab.path} onClick={() => setActivePath(tab.path)}><FileCode2 size={14} /><span>{baseName(tab.path)}</span></button>
            <button aria-label={`Close ${baseName(tab.path)}`} onClick={() => closeFile(tab.path)}><X size={12} /></button>
          </div>) : <span className={styles.noDocument}>File preview</span>}
        </div>
        {!currentTab ? <div className={styles.empty}><div className={styles.emptyIcon}><FileText size={26} /></div><h3>Your files, beside your chat</h3><p>Open a file to preview it here.<br />Upload a report or let a bot create something.</p><button className={styles.primaryButton} disabled={uploading} onClick={() => uploadRef.current?.click()}><Upload size={15} />Upload a file</button><span className={styles.hint}>Up to 10 MB · Existing files stay untouched</span></div> : currentTab.loading ? <div className={styles.empty}><Loader2 size={24} className="animate-spin" /><p>Opening {baseName(currentTab.path)}…</p></div> : currentTab.error ? <div className={styles.empty} role="alert"><FileText size={26} /><p>{currentTab.error}</p><button className={styles.secondaryButton} onClick={() => void openFile(currentTab.path)}>Try again</button></div> : currentTab.preview && <>
          <div className={styles.fileToolbar}><span title={currentTab.path}>{currentTab.path}</span><button className={styles.iconButton} aria-label="Reload file" onClick={() => void openFile(currentTab.path)}><RefreshCw size={14} /></button><button className={styles.iconButton} aria-label="Copy file path" onClick={() => void copyPath(currentTab.path)}><Copy size={14} /></button><a className={styles.iconButton} aria-label={`Download ${baseName(currentTab.path)}`} title="Download file" href={`/api/workspace/files?path=${encodeURIComponent(currentTab.path)}`} download><Download size={14} /></a></div>
          {currentTab.preview.binary ? <div className={styles.empty}><FileText size={28} /><h3>Download to open this file</h3><p>This file isn’t UTF-8 text. Download it to view it in your preferred app.</p><a className={styles.primaryButton} href={`/api/workspace/files?path=${encodeURIComponent(currentTab.path)}`} download><Download size={15} />Download file</a></div> : <pre className={styles.code} tabIndex={0} aria-label={`${baseName(currentTab.path)} file content`}><code>{currentTab.preview.text || "(Empty file)"}</code></pre>}
          <footer className={styles.fileFooter}><span>{sizeLabel(currentTab.preview.size)}{currentTab.preview.truncated ? " · Preview shortened to 256 KB" : currentTab.preview.binary ? " · Binary file" : " · UTF-8 · Read only"}</span>{onInsertPath && <button onClick={() => { onInsertPath(currentTab.path); setNotice("File path added to your message."); if (mobile) onClose(); }}>Use in chat</button>}</footer>
        </>}
      </div>
      <nav className={styles.explorer} aria-label="Workspace files">
        <div className={styles.explorerTitle}><span>FILES</span><button className={styles.iconButton} disabled={uploading} aria-label="Upload file" title="Upload file" onClick={() => uploadRef.current?.click()}>{uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}</button></div>
        <label className={styles.search}><Search size={13} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter loaded files…" aria-label="Filter workspace files" />{filter && <button aria-label="Clear file filter" onClick={() => setFilter("")}><X size={12} /></button>}</label>
        <div className={styles.tree}><div className={styles.root}><FolderOpen size={14} /><span>workspace</span></div>{loadingDirs.has(".") && !listings["."] ? <p className={styles.treeHint}>Loading files…</p> : directoryRows(".")}
          {listings["."]?.entries.length === 0 && <p className={styles.treeHint}>No files yet.<br />Uploaded and bot-created files appear here.</p>}
          {filter && !Object.values(listings).some(listing => listing.entries.some(entry => entry.type !== "dir" && entry.path.toLowerCase().includes(filter.toLowerCase()))) && <p className={styles.treeHint}>No loaded files match. Expand a folder to search its contents.</p>}
          {listings["."]?.truncated && <p className={styles.treeHint}>Showing the first 500 entries.</p>}
        </div>
        <p className={styles.explorerFoot}>Shared by your bots.<br />Private to your account.</p>
      </nav>
    </div> : <section id="workspace-terminal-view" role="tabpanel" aria-labelledby="workspace-terminal-tab" className={styles.terminal}>
      <div className={styles.terminalIntro}><span><Terminal size={14} />workspace / bash</span><button disabled={running || !commands.length} onClick={() => setCommands([])}>Clear your output</button></div>
      <div ref={terminalRef} className={styles.terminalOutput} tabIndex={0} aria-label="Terminal output">
        {!commands.length && !history.length && <div className={styles.terminalWelcome}><p>Ready when you are.</p><span>Run a command below, or watch your bot’s commands here.</span><span>Commands run in your isolated workspace without network access.</span></div>}
        {history.map(item => <article key={item.id} className={styles.command}><p className={styles.commandSource}>From this chat · {item.running ? "Running" : "Bot command"}</p><div className={styles.commandLine}><span>$</span><code>{item.command}</code></div><pre>{item.output || (item.running ? "Waiting for output…" : "No output")}</pre></article>)}
        {commands.map(item => <article key={item.id} className={styles.command}><div className={styles.commandLine}><span>$</span><code>{item.command}</code></div><pre>{item.output}</pre><div className={cn(styles.commandResult, item.status === "error" && styles.failed)}>{item.status === "running" ? <><Loader2 size={12} className="animate-spin" />Running…</> : item.status === "stopped" ? "Stopped" : item.code !== undefined ? `Exit ${item.code}` : "Could not run"}{item.detail && <span>{item.detail}</span>}{terminalOmissionNotice(item.omissions, item.clippedCharacters) && <span role="status">{terminalOmissionNotice(item.omissions, item.clippedCharacters)}</span>}</div></article>)}
      </div>
      <form className={styles.commandForm} onSubmit={runCommand}><label htmlFor="workspace-command">Run your own command</label><div className={styles.commandInput}><span aria-hidden>$</span><input id="workspace-command" value={command} onChange={event => setCommand(event.target.value)} disabled={running} placeholder="e.g. ls -la" autoComplete="off" spellCheck={false} />{running ? <button type="button" className={styles.stopButton} onClick={() => commandAbort.current?.abort()}><Square size={12} />Stop</button> : <button className={styles.runButton} disabled={!command.trim()}><Play size={12} />Run</button>}</div><p>Run executes your command. Bot commands still need approval in chat.</p></form>
    </section>}
    <input ref={uploadRef} type="file" hidden aria-label="Choose workspace upload" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    <footer className={styles.statusBar}><span><span className={cn(styles.dot, status?.state === "unavailable" && styles.offline)} />{status?.state === "unavailable" ? "Unavailable" : running ? "Command running" : status?.state === "running" ? "Running" : status?.state === "missing" ? "Ready to create" : "Ready"}</span><span>{status?.runtime === "runsc" ? "gVisor · " : ""}No network</span></footer>
  </>;

  if (mobile) return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent title="Your workspace" description="Browse files and run commands in your private workspace" hideClose className={styles.mobileDialog}><div className={styles.mobilePanel}>{content}</div></DialogContent></Dialog>;
  return <aside ref={panelRef} hidden={!open} tabIndex={-1} aria-label="Your workspace" className={styles.panel} style={{ width }}>
    <div role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" aria-valuemin={420} aria-valuemax={900} aria-valuenow={width} tabIndex={0} className={styles.resize}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(previous => Math.max(420, Math.min(900, previous + (event.key === "ArrowLeft" ? 24 : -24)))); } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(420, Math.min(900, window.innerWidth - event.clientX))); }} />
    {content}
  </aside>;
}

"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ArrowUp, AtSign, FileText, Loader2, Mic, Paperclip, Plus, Sparkles, Square, X } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { Tip } from "@/components/ui/tooltip";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { HERMES_COMMANDS } from "@/lib/chat/hermes-commands";
import { insertCommandIntoDraft, type ComposerCommand } from "@/lib/chat/composer-commands";
import { VoiceControl } from "./voice-control";
import type { VoiceTarget } from "@/lib/voice/client";

export type UploadedFile = { id: string; url: string; filename: string; mediaType: string };
type PendingFile = { key: string; filename: string; mediaType: string; preview?: string; uploaded?: UploadedFile; error?: string };

export type ComposerHandle = { focus: () => void; setText: (t: string) => void };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}
const noopSubscribe = () => () => {};

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (text: string, files: UploadedFile[]) => void | boolean | Promise<void | boolean>;
    onStop: () => void;
    busy: boolean;
    disabled?: boolean;
    tools?: React.ReactNode;
    placeholder?: string;
    skills?: { slug: string; name: string; description: string }[];
    hermesCommands?: { models: string[]; discoveryNote: string };
    /** What the "/" button lists; only commands this chat can run. Undefined hides the button. */
    commands?: ComposerCommand[];
    /** group chats: bots that can be @mentioned */
    mentions?: { id?: string; name: string; icon: string | null; label?: string | null }[];
    autoFocus?: boolean;
    /** Send button colour (a bot chat uses the bot's colour, like ChatGPT dots). */
    tint?: { bg: string; fg: string };
    voiceTarget?: VoiceTarget;
  }
>(function Composer({ onSend, onStop, busy, disabled, tools, placeholder = "Ask anything", skills = [], hermesCommands, commands, mentions = [], autoFocus, tint, voiceTarget }, ref) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const commandButtonRef = useRef<HTMLButtonElement>(null);
  const commandChosen = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => taRef.current?.focus());
    },
  }));

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const upload = useCallback(async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = Math.random().toString(36).slice(2);
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((f) => [...f, { key, filename: file.name, mediaType: file.type || "application/octet-stream", preview }]);
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/files", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Upload failed");
        setFiles((f) => f.map((x) => (x.key === key ? { ...x, uploaded: body } : x)));
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof Error ? err.message : "Upload failed"}`);
        setFiles((f) => f.filter((x) => x.key !== key));
      }
    }
  }, []);

  // Dictation (Web Speech API, where the browser supports it).
  const canDictate = useSyncExternalStore(noopSubscribe, () => !!speechCtor(), () => false);
  const [listening, setListening] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const toggleDictation = useCallback(() => {
    if (voiceActive) return;
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let said = "";
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
      if (said) setText((t) => (t && !t.endsWith(" ") ? t + " " : t) + said.trim());
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  }, [voiceActive]);

  const uploading = files.some((f) => !f.uploaded && !f.error);
  const hasContent = text.trim().length > 0 || files.some((f) => f.uploaded);
  // While a reply is running you can still send: the current turn stops and your new instruction goes next.
  const canSend = !disabled && !uploading && !submitting && hasContent;

  async function submit() {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    setSubmitting(true);
    const draft = text;
    const sentKeys = new Set(files.map((f) => f.key));
    try {
      const accepted = await onSend(text.trim(), files.flatMap((f) => (f.uploaded ? [f.uploaded] : [])));
      if (accepted !== false) {
        setText((current) => current === draft ? "" : current);
        setFiles((current) => current.filter((f) => !sentKeys.has(f.key)));
      }
    } finally {
      sendingRef.current = false;
      setSubmitting(false);
    }
  }

  const slashQuery = /^\/([\w-]*)$/.exec(text)?.[1];
  const skillMatches = !hermesCommands && slashQuery !== undefined ? skills.filter((s) => s.slug.startsWith(slashQuery.toLowerCase())).slice(0, 6) : [];
  const commandQuery = /^\/(?:hermes\s+)?([\w-]*)$/i.exec(text)?.[1]?.toLowerCase();
  const modelQuery = /^\/(?:hermes\s+)?model\s+(\S*)$/i.exec(text)?.[1];
  const prefix = /^\/hermes\s/i.test(text) ? "/hermes " : "/";
  const commandMatches = !hermesCommands || menuDismissed ? [] : modelQuery !== undefined
    ? [...new Set(["default", ...hermesCommands.models])].filter((m) => m.startsWith(modelQuery)).map((m) => ({ value: `${prefix}model ${m}`, description: m === "default" ? "Clear this chat's model request" : "Request this route for future turns" }))
    : commandQuery !== undefined ? HERMES_COMMANDS.filter((c) => c.name.startsWith(commandQuery)).map((c) => ({ value: `${prefix}${c.name}`, description: c.description })) : [];
  const selectedIndex = Math.min(menuIndex, Math.max(0, commandMatches.length - 1));
  useEffect(() => {
    if (commandMatches.length) document.getElementById(`hermes-command-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, commandMatches.length]);
  function insertCommand(value: string) {
    setText(`${value} `);
    setMenuIndex(0);
    setMenuDismissed(false);
    taRef.current?.focus();
  }
  /** Choosing from the "/" button only edits the draft; sending still needs Enter or the send button. */
  function chooseCommand(value: string) {
    commandChosen.current = true;
    setText((t) => insertCommandIntoDraft(t, value));
    setMenuIndex(0);
    setMenuDismissed(false);
  }
  const commandGroups = (["Commands", "Skills"] as const).map((group) => ({ group, items: (commands ?? []).filter((c) => c.group === group) })).filter((g) => g.items.length);
  const mentionMatch = mentions.length ? /(^|\s)@([^@\n]{0,40})$/.exec(text) : null;
  const mentionQuery = mentionMatch?.[2].toLowerCase();
  const mentionOptions =
    mentionQuery !== undefined
      ? [...mentions, { name: "everyone", icon: null, label: "All bots in this group" }].filter((m) => m.name.toLowerCase().startsWith(mentionQuery))
      : [];
  function insertMention(name: string) {
    setText((t) => t.replace(/@([^@\n]{0,40})$/, `@${name} `));
    taRef.current?.focus();
  }

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      {commandMatches.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-2xl border border-border bg-surface p-1.5 shadow-lg" data-testid="hermes-command-menu">
          <p className="px-2.5 py-1 text-xs text-subtle">Hermes controls · ↑↓ choose · Tab / Enter complete · Esc close</p>
          <div id="hermes-command-options" role="listbox" aria-label="Hermes commands" className="max-h-64 overflow-y-auto">
            {commandMatches.map((c, i) => (
              <button key={c.value} id={`hermes-command-${i}`} role="option" aria-selected={i === selectedIndex}
                onMouseDown={(e) => e.preventDefault()} onClick={() => insertCommand(c.value)}
                className={cn("flex w-full gap-2 rounded-lg px-2.5 py-2 text-left text-sm", i === selectedIndex ? "bg-hover" : "hover:bg-hover")}>
                <span className="shrink-0 font-mono">{c.value}</span><span className="text-muted">{c.description}</span>
              </button>
            ))}
          </div>
          <p className="px-2.5 py-1 text-xs text-subtle">{hermesCommands?.discoveryNote}</p>
        </div>
      )}
      {mentionOptions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover p-1.5 shadow-lg">
          <div className="px-2.5 py-1 text-xs text-subtle">Mention a bot</div>
          {mentionOptions.map((m) => (
            <button
              key={m.name}
              onClick={() => insertMention(m.name)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
            >
              {m.name === "everyone" ? <AtSign className="h-5 w-5 text-muted" /> : <BotAvatar botId={"id" in m ? m.id : undefined} value={m.icon} className="h-5 w-5" />}
              <span className="font-medium">@{m.name}</span>
              {m.label && <span className="text-xs text-muted">{m.label}</span>}
            </button>
          ))}
        </div>
      )}
      {skillMatches.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover p-1.5 shadow-lg">
          <div className="px-2.5 py-1 text-xs text-subtle">Skills</div>
          {skillMatches.map((s) => (
            <button
              key={s.slug}
              onClick={() => {
                setText(`/${s.slug} `);
                taRef.current?.focus();
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
            >
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                <span className="font-medium">/{s.slug}</span> <span className="text-muted">— {s.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "rounded-[28px] bg-surface p-2.5 shadow-composer transition-colors",
          dragging && "ring-2 ring-accent",
        )}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1.5 pb-2 pt-1">
            {files.map((f) => (
              <div key={f.key} className="group relative">
                {f.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.preview} alt={f.filename} className="h-14 w-14 rounded-xl object-cover" />
                ) : (
                  <div className="flex h-14 max-w-[220px] items-center gap-2 rounded-xl border border-border bg-bg px-2 pr-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#ff5588] text-white">
                      <FileText className="h-4 w-4" />
                    </span>
                    <span className="truncate text-sm">{f.filename}</span>
                  </div>
                )}
                {!f.uploaded && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/30">
                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                  </div>
                )}
                <button
                  onClick={() => setFiles((l) => l.filter((x) => x.key !== f.key))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-fg p-0.5 text-bg"
                  aria-label={`Remove ${f.filename}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => { setText(e.target.value); setMenuIndex(0); setMenuDismissed(false); }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              upload(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (commandMatches.length && !e.shiftKey) {
              if (e.key === "Escape") { e.preventDefault(); setMenuDismissed(true); return; }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); setMenuIndex((selectedIndex + (e.key === "ArrowDown" ? 1 : -1) + commandMatches.length) % commandMatches.length); return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && commandMatches[selectedIndex].value !== text.trim())) {
                e.preventDefault(); insertCommand(commandMatches[selectedIndex].value); return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (mentionOptions.length === 1 && mentionQuery) insertMention(mentionOptions[0].name);
              else submit();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && canDictate) {
              e.preventDefault();
              toggleDictation();
            }
          }}
          placeholder={placeholder}
          className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-base outline-none placeholder:text-subtle"
          aria-label="Message"
          role={hermesCommands ? "combobox" : undefined}
          aria-autocomplete={hermesCommands ? "list" : undefined}
          aria-expanded={hermesCommands ? commandMatches.length > 0 : undefined}
          aria-controls={commandMatches.length ? "hermes-command-options" : undefined}
          aria-activedescendant={commandMatches.length ? `hermes-command-${selectedIndex}` : undefined}
        />
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex items-center gap-0.5">
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-9 w-9 items-center justify-center rounded-full text-fg hover:bg-hover" aria-label="Add files">
                <Plus className="h-5 w-5" />
              </button>
            </MenuTrigger>
            <MenuContent side="top" align="start">
              <MenuItem onSelect={() => fileRef.current?.click()}>
                <Paperclip /> Add photos & files
              </MenuItem>
            </MenuContent>
          </Menu>
          {tools}
          {commands && (
            <Menu onOpenChange={(open) => {
              if (open) { commandChosen.current = false; return; }
              // Escape or a click outside returns focus to the button; a choice continues in the message box.
              requestAnimationFrame(() => (commandChosen.current ? taRef.current : commandButtonRef.current)?.focus());
            }}>
              <Tip label="Commands" side="top">
                <MenuTrigger asChild>
                  <button ref={commandButtonRef} type="button" disabled={disabled} aria-label="Commands"
                    className="flex h-9 w-9 items-center justify-center rounded-full font-mono text-lg font-semibold leading-none text-fg hover:bg-hover disabled:opacity-40">
                    /
                  </button>
                </MenuTrigger>
              </Tip>
              <MenuContent side="top" align="start" className="max-h-80 w-[min(26rem,calc(100vw-2rem))] overflow-y-auto">
                {commandGroups.length ? commandGroups.map(({ group, items }) => (
                  <div key={group} role="group" aria-label={group}>
                    <MenuLabel>{group === "Skills" ? "Skills for this bot" : hermesCommands ? "Hermes controls" : "Commands"}</MenuLabel>
                    {items.map((c) => (
                      <MenuItem key={c.value} onSelect={() => chooseCommand(c.value)} className="items-start" data-testid="composer-command">
                        {group === "Skills" ? <Sparkles className="mt-0.5 shrink-0 text-accent" /> : null}
                        <span className="min-w-0">
                          <span className="font-mono">{c.value}</span>{c.args && <span className="ml-1 font-mono text-xs text-subtle">{c.args}</span>}
                          <span className="block text-xs text-muted">{c.description}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </div>
                )) : (
                  <p role="status" className="max-w-xs px-2.5 py-2 text-sm text-muted">No commands are available in this chat. Bots can offer skills here, and Hermes bots offer chat controls.</p>
                )}
                <p className="max-w-sm px-2.5 pb-1 pt-1.5 text-xs text-subtle">
                  {commandGroups.length ? "Choosing one adds it to your message; nothing is sent until you press Enter." : ""}
                  {hermesCommands ? ` ${hermesCommands.discoveryNote}` : ""}
                </p>
              </MenuContent>
            </Menu>
          )}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) upload(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="flex items-center gap-1.5">
            {canDictate && (
              <Tip label={listening ? "Stop dictation" : "Dictate (Ctrl/⌘ D)"}>
                <button
                  onClick={toggleDictation}
                  disabled={voiceActive}
                  className={cn("flex h-9 w-9 items-center justify-center rounded-full hover:bg-hover disabled:opacity-40", listening && "animate-pulse bg-danger/15 text-danger")}
                  aria-label={listening ? "Stop dictation" : "Start voice input"}
                >
                  <Mic className="h-5 w-5" />
                </button>
              </Tip>
            )}
            {voiceTarget && !listening && <VoiceControl key={`${voiceTarget.appId ?? ""}:${voiceTarget.botId ?? ""}:${voiceTarget.conversationId ?? ""}`} target={voiceTarget} disabled={disabled} onActiveChange={setVoiceActive} />}
            {busy && !hasContent ? (
              <button onClick={onStop} className="flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg" aria-label="Stop generating">
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg transition-opacity disabled:opacity-30"
                style={tint ? { background: tint.bg, color: tint.fg } : undefined}
                aria-label={busy ? "Stop and send" : "Send message"}
                title={busy ? "Stop the current reply and send this instead" : undefined}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

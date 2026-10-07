"use client";
import { HermesNativeControls } from "./hermes-native-controls";
import { HermesTeamChatControls } from "./hermes-team-chat-controls";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { toast } from "sonner";
import { ArrowDown, Menu as MenuIcon, Monitor, PanelRightClose, PanelRightOpen, SquarePen } from "lucide-react";
import { grantToolForBot, setConversationLeaf, setMessageFeedback } from "@/app/(chat)/actions";
import type { PortalUIMessage } from "@/lib/chat/store";
import { newId } from "@/lib/ids";
import { NativeSearchControl } from "./native-search-control";
import type { NativeSearchMode } from "@/lib/native-search-policy";
import { Composer, type ComposerHandle, type UploadedFile } from "./composer";
import { AssistantMessage, hasContent, UserMessage, type BranchInfo } from "./message";
import { DelegatedApprovals } from "./delegated-approvals";
import { ShareButton } from "./share-dialog";
import { useShell } from "./shell-context";
import { TargetPicker } from "./target-picker";
import type { TargetOption } from "./types";
import { BotAvatar, bubbleTint, type BlobState } from "@/components/bots/bot-avatar";
import { previewLine } from "@/lib/chat/preview";
import { cn } from "@/lib/utils";
import { formatDuration, needsAction, useElapsed } from "./steps";
import { BotSidePanel } from "@/components/bots/bot-side-panel";
import { BotChatNavigation } from "./bot-chat-navigation";
import { parseHermesInput, type CommandResult, type HermesCommandCatalog } from "@/lib/chat/hermes-commands";
import { buildCommandRequest, composerCommands } from "@/lib/chat/composer-commands";
import { CommandResultCard } from "./command-result";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { PetChatActivity } from "@/components/pets/pet-context";
import { hasPendingAsyncTasks } from "@/lib/delegation/policy";
import type { ConversationSnapshot } from "@/lib/chat/snapshot";
import styles from "./chat.module.css";

export type TreeRow = {
  id: string;
  parentId: string | null;
  createdAt: number;
  feedback: 1 | -1 | null;
  message: PortalUIMessage;
};

function pathTo(rows: Map<string, TreeRow>, leafId: string | null): TreeRow[] {
  const out: TreeRow[] = [];
  let cur = leafId ? rows.get(leafId) : undefined;
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? rows.get(cur.parentId) : undefined;
  }
  return out;
}

function childrenOf(rows: Map<string, TreeRow>, parentId: string | null) {
  return [...rows.values()].filter((r) => r.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt);
}

function descendLatest(rows: Map<string, TreeRow>, fromId: string) {
  let cur = fromId;
  for (;;) {
    const kids = childrenOf(rows, cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}

const nowMs = () => Date.now();

export function Chat({
  conversationId: givenId,
  isNew,
  target: initialTarget,
  initialRows,
  initialLeafId,
  skills,
  embedded,
  resume,
  isBotHome = false,
  unavailable = false,
  unavailableReason,
}: {
  embedded?: boolean;
  /** A reply is in progress on the server (after a reload): replay it and follow it to the end. */
  resume?: boolean;
  /** omitted for a brand-new chat: the id is generated in the browser */
  conversationId?: string;
  isNew: boolean;
  isBotHome?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  target: TargetOption | null;
  initialRows: TreeRow[];
  initialLeafId: string | null;
  skills?: { slug: string; name: string; description: string }[];
}) {
  const router = useRouter();
  const [conversationId] = useState(() => givenId ?? newId());
  const { user, branding, upsertConversation, setMobileOpen, apps, bots, setBotLive, setChatStatus, serverBots } = useShell();
  const [target, setTarget] = useState<TargetOption | null>(initialTarget);
  const [started, setStarted] = useState(!isNew);
  const [nativeSearchMode, setNativeSearchMode] = useState<NativeSearchMode | null>(null);
  const [searchPending, setSearchPending] = useState(true);
  const searchPendingRef = useRef(true);
  const searchChanged = useCallback((mode: NativeSearchMode | null, pending: boolean) => {
    searchPendingRef.current = pending;
    setNativeSearchMode(mode); setSearchPending(pending);
  }, []);
  // Deliberately visit-local: every chat mount/reload starts collapsed. Opening
  // details never writes a preference or remounts the conversation/composer.
  const [detailsView, setDetailsView] = useState<"desktop" | "mobile" | null>(null);
  const detailsId = useId();
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const detailsFocusRef = useRef<HTMLElement | null>(null);
  const detailsLabel = detailsView ? "Hide bot details" : "Show bot details";
  const controlledDetailsId = detailsView === "mobile" ? `${detailsId}-mobile` : detailsId;
  const openDetails = () => setDetailsView(window.matchMedia("(min-width: 1024px)").matches ? "desktop" : "mobile");
  const closeDetails = () => {
    setDetailsView(null);
    detailsToggleRef.current?.focus();
  };
  useEffect(() => {
    const layout = window.matchMedia("(min-width: 1024px)");
    const closeOnLayoutChange = () => {
      // A CSS-hidden panel must never retain keyboard focus. Close the old view
      // instead of opening an unsolicited modal when the screen gets smaller.
      const focusedDetails = detailsFocusRef.current;
      const restoreFocus = focusedDetails === document.activeElement;
      setDetailsView(null);
      // React focus events include portaled dialogs (pet settings, routines).
      // Wait until they unmount so their focus trap cannot intercept restoration.
      if (restoreFocus) requestAnimationFrame(() => {
        if (!focusedDetails?.isConnected) detailsToggleRef.current?.focus();
      });
    };
    layout.addEventListener("change", closeOnLayoutChange);
    return () => layout.removeEventListener("change", closeOnLayoutChange);
  }, []);
  const composerRef = useRef<ComposerHandle>(null);
  const commandScope = `${conversationId}:${target?.kind}:${target?.id}`;
  const [commandOutput, setCommandOutput] = useState<{ scope: string; result: CommandResult } | null>(null);
  const [catalogState, setCatalogState] = useState<{ scope: string; value: HermesCommandCatalog | null; error?: boolean } | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalog = catalogState?.scope === commandScope ? catalogState.value : null;
  const commandAttempt = useRef<{ scope: string; text: string; nextId: string } | null>(null);
  const commandRevisions = useRef(new Map<string, number>());
  const hermes = target?.hermes === true && target.kind !== "group";

  useEffect(() => {
    if (!hermes) return;
    const ac = new AbortController();
    const query = new URLSearchParams({ conversationId });
    if (target?.kind === "app") query.set("appId", target.id);
    if (target?.kind === "bot") query.set("botId", target.id);
    void fetch(`/api/chat/commands?${query}`, { signal: ac.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Discovery unavailable");
        const value = await response.json() as HermesCommandCatalog;
        if (!ac.signal.aborted) {
          if (value.backend === "hermes") commandRevisions.current.set(commandScope, Math.max(commandRevisions.current.get(commandScope) ?? 0, value.revision));
          setCatalogState({ scope: commandScope, value: value.backend === "hermes" ? value : null });
        }
      }).catch(() => { if (!ac.signal.aborted) setCatalogState({ scope: commandScope, value: null, error: true }); });
    return () => ac.abort();
  }, [hermes, conversationId, target?.kind, target?.id, commandScope, catalogVersion]);

  const hermesCommands = hermes ? {
    models: catalog?.models.available ? catalog.models.items : [],
    routes: catalog?.modelRoutes ?? [],
    requested: catalog?.requestedModel ?? null,
    discoveryNote: !catalog ? (catalogState?.scope === commandScope && catalogState.error ? "Discovery unavailable; local controls still work." : "Checking Hermes capabilities… Local controls are ready.")
      : catalog.capabilityWarning ?? (!catalog.skills.available ? "Skills discovery unavailable. /skills explains; chat still works." : "Skills are discoverable with /skills; native invocation is not available yet."),
  } : undefined;
  const commandResult = commandOutput?.scope === commandScope ? commandOutput.result : null;
  const composerCommandList = target ? composerCommands({ kind: target.kind, hermes, embedded, skills }) : undefined;
  const voiceTarget = target?.kind === "app" ? { appId: target.id, ...(started ? { conversationId } : {}) }
    : target?.kind === "bot" ? { botId: target.id, ...(started ? { conversationId } : {}) } : undefined;

  // Messages from other branches (edits / regenerations). useChat only holds the visible path; the
  // full tree is derived from both, so nothing is lost when the visible path changes.
  const [stored, setStored] = useState(() => new Map<string, TreeRow>(initialRows.map((r) => [r.id, r])));
  const [initialPath] = useState(() => pathTo(stored, initialLeafId).map((r) => r.message));
  const [feedback, setFeedback] = useState<Record<string, 1 | -1 | null>>(() =>
    Object.fromEntries(initialRows.map((r) => [r.id, r.feedback])),
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<PortalUIMessage>({
        api: "/api/chat",
        // appId/botId arrive per request (see targetBody) and only matter for a brand-new conversation.
        prepareSendMessagesRequest: ({ messages, trigger, body }) => {
          const base = { ...body, conversationId };
          const last = messages[messages.length - 1];
          if (trigger === "regenerate-message") {
            return { body: { ...base, regenerate: true, parentId: last?.id } };
          }
          if (last?.role === "assistant") {
            return { body: { ...base, message: { id: last.id, role: last.role, parts: last.parts } } };
          }
          return {
            body: {
              ...base,
              message: { id: last.id, role: last.role, parts: last.parts },
              parentId: messages.length > 1 ? messages[messages.length - 2].id : null,
            },
          };
        },
      }),
    [conversationId],
  );

  // Resume is decided once, on mount: a later server re-render (revalidatePath from a sidebar action) may flip the prop
  // while this instance's own stream is still running, which must not start a second stream.
  const [resumeOnMount] = useState(resume);
  const { messages, setMessages, sendMessage, regenerate, stop, resumeStream, status, addToolApprovalResponse, error, clearError } = useChat<PortalUIMessage>({
    id: conversationId,
    messages: initialPath,
    resume: resumeOnMount,
    transport,
    generateId: () => newId(),
    sendAutomaticallyWhen: (options) => !unavailable && !searchPendingRef.current && lastAssistantMessageIsCompleteWithApprovalResponses(options),
    onData: (part) => {
      if (part.type === "data-title") {
        upsertConversation({ id: conversationId, title: (part.data as { title: string }).title });
      } else if (part.type === "data-notice") {
        toast.warning((part.data as { message: string }).message);
      }
    },
    onFinish: () => upsertConversation({ id: conversationId, updatedAt: new Date().toISOString() }),
    onError: (err) => {
      let msg = err.message;
      try {
        msg = JSON.parse(err.message).error ?? msg;
      } catch {}
      toast.error(msg || "Something went wrong");
    },
  });

  // A confirmed delegation output means its child already exists. Refresh recents as soon as it arrives;
  // shell polling also discovers work created in other tabs and recovers disconnected streams.
  const taskChanges = messages.flatMap(m => m.parts.flatMap(part => {
    if (!("output" in part) || !part.output || typeof part.output !== "object" || !("taskId" in part.output)) return [];
    const output = part.output as { taskId?: string; status?: string };
    return typeof output.taskId === "string" ? [`${output.taskId}:${output.status}`] : [];
  })).join("|");
  useEffect(() => { if (taskChanges) window.dispatchEvent(new Event("recent-tasks-changed")); }, [taskChanges]);

  // The server refused the request before saving anything (busy, over the reply limit, …): take the message back into
  // the composer, or show an answer's approval cards again, so what's on screen matches what's stored.
  const rejectedDraft = useRef<{ messageId: string; text: string } | null>(null);
  useEffect(() => {
    if (!error) return;
    let body: { unsavedMessageId?: unknown; retryApprovalMessageId?: unknown } | null = null;
    try {
      body = JSON.parse(error.message) as { unsavedMessageId?: unknown; retryApprovalMessageId?: unknown };
    } catch {}
    const last = messages.at(-1);
    if (last?.role === "user" && body?.unsavedMessageId === last.id) {
      rejectedDraft.current = { messageId: last.id, text: last.parts.map((p) => (p.type === "text" ? p.text : "")).join("") };
      setMessages(messages.slice(0, -1));
    } else if (last?.role === "assistant" && body?.retryApprovalMessageId === last.id) {
      const reopened = last.parts.map((p) => {
        if (!isToolUIPart(p) || p.state !== "approval-responded") return p;
        return { ...p, state: "approval-requested", approval: { id: p.approval.id } } as unknown as typeof p;
      });
      setMessages([...messages.slice(0, -1), { ...last, parts: reopened }]);
    } else return;
    clearError();
  }, [error, messages, setMessages, clearError]);

  // Removing the first rejected message mounts the empty-chat composer. Restore after that commit,
  // so a first-use provisioning failure cannot write the draft into the outgoing composer instance.
  useEffect(() => {
    const draft = rejectedDraft.current;
    if (!draft || messages.some((m) => m.id === draft.messageId)) return;
    composerRef.current?.setText(draft.text);
    rejectedDraft.current = null;
  }, [messages]);

  const tree = useMemo(() => {
    const t = new Map(stored);
    messages.forEach((m, i) => {
      const existing = stored.get(m.id);
      t.set(m.id, {
        id: m.id,
        parentId: i > 0 ? messages[i - 1].id : null,
        createdAt: existing?.createdAt ?? m.metadata?.createdAt ?? Number.MAX_SAFE_INTEGER,
        feedback: existing?.feedback ?? null,
        message: m,
      });
    });
    return t;
  }, [stored, messages]);

  /** Remember the current path before replacing it (branch switch, edit, regenerate). */
  const keepCurrentBranch = () => setStored(tree);

  const streamingBusy = status === "submitted" || status === "streaming";
  const awaitingTasks = hasPendingAsyncTasks(messages.at(-1));
  const busy = streamingBusy || awaitingTasks;

  // A task wait has no open worker or HTTP stream. Resume only the committed next segment.
  useEffect(() => {
    if (!awaitingTasks || streamingBusy) return;
    let alive = true, pending = false;
    const tick = async () => {
      if (!alive || pending || document.hidden) return;
      pending = true;
      try {
        const response = await fetch(`/api/chat/${conversationId}`, { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as ConversationSnapshot;
        if (!alive || next.run?.status === "waiting_tasks") return;
        if (next.resume && (next.run?.status === "queued" || next.run?.status === "running")) await resumeStream();
        else {
          const rows = new Map(next.initialRows.map(r => [r.id, r]));
          setStored(rows);
          setMessages(pathTo(rows, next.initialLeafId).map(r => r.message));
        }
      } finally { pending = false; }
    };
    const timer = setInterval(() => void tick().catch(() => {}), 2000);
    window.addEventListener("focus", tick);
    void tick().catch(() => {});
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [awaitingTasks, streamingBusy, conversationId, resumeStream, setMessages]);

  // What the bot is doing right now, for its avatar, the header and the sidebar (Grok Bot shows state, not typing dots).
  const lastMessage = messages.at(-1);
  const liveReply = busy && lastMessage?.role === "assistant" ? lastMessage : null;
  const toolRunning = !!liveReply?.parts.some((p) => isToolUIPart(p) && ["input-streaming", "input-available", "approval-responded"].includes(p.state));
  const workspaceRunning = !!liveReply?.parts.some((p) => isToolUIPart(p) && p.type.startsWith("tool-workspace_") && ["input-streaming", "input-available", "approval-responded"].includes(p.state));
  const usesWorkspace = messages.some((m) => m.parts.some((p) => isToolUIPart(p) && p.type.startsWith("tool-workspace_")));
  const awaitingApproval = !busy && lastMessage?.role === "assistant" && lastMessage.parts.some(needsAction);
  const replyHasText = !!liveReply?.parts.some((p) => p.type === "text" && p.text);
  const botState: BlobState = awaitingApproval ? "waiting" : awaitingTasks ? "working" : !busy ? "idle" : toolRunning ? "working" : status === "submitted" || !replyHasText ? "thinking" : "working";
  const elapsed = useElapsed(liveReply?.metadata?.startedAt, toolRunning);

  /**
   * Stops the reply on the server (it runs in the background worker, so closing the stream alone doesn't). Only from
   * the Stop buttons: never on unmount, pagehide or beforeunload, since leaving the page must let the reply finish.
   */
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastMessageIdRef.current = messages.at(-1)?.id;
  }, [messages]);
  const requestServerStop = useCallback(async () => {
    if (!started || target?.kind === "group") return;
    // Names the message the reply answers, so a Stop pressed before its run exists (the request is still being
    // handled) stops it as soon as it does.
    const res = await fetch(`/api/chat/${conversationId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: lastMessageIdRef.current }),
    });
    if (!res.ok) throw new Error(`stop failed (${res.status})`);
  }, [started, target?.kind, conversationId]);
  const stopReply = () => {
    void requestServerStop().catch(() => {});
    stop();
  };

  const branchInfo = useCallback(
    (m: PortalUIMessage, index: number): BranchInfo | undefined => {
      const parentId = index > 0 ? messages[index - 1].id : null;
      const siblings = childrenOf(tree, parentId);
      if (siblings.length < 2) return undefined;
      const idx = siblings.findIndex((s) => s.id === m.id);
      const go = (to: number) => {
        if (busy) return;
        const leaf = descendLatest(tree, siblings[to].id);
        setStored(tree);
        setMessages(pathTo(tree, leaf).map((r) => r.message));
        void setConversationLeaf(conversationId, leaf).catch(() => {});
      };
      return { index: idx, total: siblings.length, onPrev: () => go(idx - 1), onNext: () => go(idx + 1) };
    },
    [messages, tree, busy, setMessages, conversationId],
  );

  function begin() {
    if (!started) {
      setStarted(true);
      if (!embedded) window.history.replaceState(null, "", `/c/${conversationId}`);
      upsertConversation({
        id: conversationId,
        title: "New chat",
        appId: target?.kind === "app" ? target.id : null,
        botId: target?.kind === "bot" ? target.id : null,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const targetBody = { nativeSearchMode, appId: target?.kind === "app" ? target.id : undefined, botId: target?.kind === "bot" ? target.id : undefined };

  // Redirect work in progress: sending while a reply streams stops it, then sends the new instruction.
  const pendingRef = useRef<{ text: string; files: UploadedFile[] } | null>(null);
  async function executeCommand(text: string, files: UploadedFile[]): Promise<boolean> {
    if (files.length) {
      setCommandOutput({ scope: commandScope, result: { title: "Command not sent", lines: ["Remove attachments before running a command. Your draft and files have been kept."] } });
      return false;
    }
    if (commandAttempt.current?.scope !== commandScope || commandAttempt.current.text !== text)
      commandAttempt.current = { scope: commandScope, text, nextId: newId() };
    try {
      const response = await fetch("/api/chat/commands", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCommandRequest({ conversationId, ...targetBody, text, revision: commandRevisions.current.get(commandScope) ?? 0, newConversationId: commandAttempt.current.nextId, messageId: lastMessageIdRef.current })),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Command failed. Your draft has been kept.");
      setCommandOutput({ scope: commandScope, result });
      commandAttempt.current = null;
      if (result.conversationId) begin();
      if (result.revision !== undefined) {
        commandRevisions.current.set(commandScope, Math.max(commandRevisions.current.get(commandScope) ?? 0, result.revision));
        setCatalogVersion((v) => v + 1);
      }
      if (result.refresh && started) {
        pendingRef.current = null;
        await stop();
        // Replay the server's closing chunks, including cancelled approval cards.
        void resumeStream();
      }
      if (typeof result.navigateTo === "string" && /^\/c\/[A-Za-z0-9_-]{8,64}$/.test(result.navigateTo)) { router.push(result.navigateTo); router.refresh(); }
      return true;
    } catch (err) {
      setCommandOutput({ scope: commandScope, result: { title: "Command not completed", lines: [err instanceof Error ? err.message : "Connection lost. Your draft has been kept; retry the command."] } });
      setCatalogVersion((v) => v + 1);
      return false;
    }
  }
  function send(text: string, files: UploadedFile[]): void | boolean | Promise<boolean> {
    if (searchPendingRef.current) return false;
    if (!target || unavailable) { toast.error("Pick a model or bot first"); return false; }
    const parsed = parseHermesInput(text);
    const localFresh = target.kind === "bot" && parsed.kind === "command" && ["new", "reset"].includes(parsed.name);
    const input = hermes || localFresh ? parsed : { kind: "text" as const, text: target.kind === "bot" && parsed.kind === "text" && parsed.literal ? parsed.text : text, literal: false };
    if (input.kind === "command") return executeCommand(text, files);
    if (busy) {
      const stopping = pendingRef.current != null;
      pendingRef.current = { text, files };
      // Stop on the server first, so the new message finds the previous reply stopped (or being saved), not running.
      if (!stopping) {
        void requestServerStop()
          .catch(() => {})
          .then(() => {
            // Unless the reply ended by itself meanwhile and the pending message was already sent.
            if (pendingRef.current) stop();
          });
      }
      return;
    }
    begin();
    sendMessage(
      {
        text: input.text || undefined,
        files: files.map((f) => ({ type: "file" as const, mediaType: f.mediaType, filename: f.filename, url: f.url })),
        metadata: { createdAt: nowMs() },
      } as Parameters<typeof sendMessage>[0],
      { body: { ...targetBody, literalSlash: input.literal } },
    );
  }

  useEffect(() => {
    if (!busy && pendingRef.current) {
      const next = pendingRef.current;
      pendingRef.current = null;
      send(next.text, next.files);
    }
  });

  function editMessage(index: number, text: string) {
    if (searchPendingRef.current || busy || unavailable) return;
    const original = messages[index];
    const files = original.parts.filter((p) => p.type === "file");
    keepCurrentBranch();
    setMessages(messages.slice(0, index));
    sendMessage({ parts: [...files, { type: "text", text }], metadata: { createdAt: nowMs() } } as Parameters<typeof sendMessage>[0], {
      body: targetBody,
    });
  }

  // Auto-scroll like ChatGPT: stick to bottom while streaming unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  const botName = target?.kind === "bot" ? target.name : undefined;
  const liveBotId = target?.kind === "bot" && started ? target.id : null;
  const lastText = !busy && lastMessage ? previewLine(lastMessage.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")) : null;
  // This chat reports only its own activity; the roster combines it with the bot's other chats (a side chat can still
  // be waiting for approval while this one is idle). A reply that just ended re-reads the server's status if it showed busy.
  const chatStatus = awaitingApproval ? "waiting" : busy ? "working" : null;
  const wasActive = useRef(false);
  const chatStatusRef = useRef(chatStatus);
  const serverStatus = liveBotId ? serverBots.find((b) => b.id === liveBotId)?.status : null;
  useEffect(() => {
    if (!liveBotId) return;
    chatStatusRef.current = chatStatus;
    setChatStatus(conversationId, liveBotId, chatStatus);
    if (wasActive.current && !chatStatus && serverStatus) router.refresh();
    wasActive.current = !!chatStatus;
  }, [liveBotId, conversationId, chatStatus, serverStatus, setChatStatus, router]);
  // Leaving the chat: a pending approval still needs you; a reply still streaming is no longer watched from here.
  useEffect(() => {
    if (!liveBotId) return;
    return () => { if (chatStatusRef.current !== "waiting") setChatStatus(conversationId, liveBotId, null); };
  }, [liveBotId, conversationId, setChatStatus]);
  useEffect(() => {
    if (!liveBotId || !isBotHome || !lastText || !lastMessage) return;
    setBotLive(liveBotId, { preview: lastMessage.role === "user" ? `You: ${lastText}` : lastText, lastAt: new Date(lastMessage.metadata?.createdAt ?? Date.now()).toISOString() });
  }, [liveBotId, isBotHome, lastText, lastMessage, setBotLive]);
  const bubbles = target?.kind === "bot" || target?.kind === "group";
  const variant = bubbles ? "bubbles" : "plain";
  const tint = target?.kind === "bot" ? bubbleTint(target.icon) : undefined;
  const botStatusText =
    awaitingTasks ? "Waiting for delegated tasks…" : botState === "waiting" ? "Needs your approval" : botState === "thinking" ? "Thinking…" : botState === "working" ? (toolRunning ? `Working${elapsed ? ` · ${formatDuration(elapsed)}` : "…"}` : "Replying…") : null;
  const mentionList = target?.kind === "group" ? (target.members ?? []).map((m) => ({ id: m.id, name: m.name, icon: m.icon, label: m.label })) : [];
  const empty = messages.length === 0;
  const centeredBotHeader = target?.kind === "bot" && started;
  const overlayHeader = centeredBotHeader && !empty && !unavailable;
  const paneRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const header = headerRef.current;
    if (!overlayHeader || !pane || !header) return;
    // Share the real header height with the scroller: controls gain a row on narrow
    // panes, and font sizing can change it too. Keep the first message below it.
    const measure = () => {
      const scroll = scrollRef.current;
      const atEnd = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 1;
      pane.style.setProperty("--bot-chat-header-height", `${header.getBoundingClientRect().height}px`);
      if (scroll && atEnd) scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--bot-chat-header-height");
    };
  }, [overlayHeader]);
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");

  const approve = (id: string) => { if (!searchPendingRef.current) addToolApprovalResponse({ id, approved: true }); };
  const deny = (id: string) => { if (!searchPendingRef.current) addToolApprovalResponse({ id, approved: false, reason: "The user denied this action." }); };
  const alwaysAllow = async (id: string, toolName: string) => {
    if (searchPendingRef.current) return;
    if (target?.kind === "bot") await grantToolForBot(target.id, toolName).catch(() => {});
    approve(id);
  };

  return (
    <div className="flex h-full">
      <div ref={paneRef} className="@container/chat-pane flex h-full min-w-0 flex-1 flex-col">
        {/* Header */}
        <header ref={headerRef} className={cn("shrink-0 gap-2 px-2 md:px-3", centeredBotHeader ? "grid grid-cols-[minmax(0,1fr)_auto] items-start pt-2 pb-3" : "flex h-14 items-center justify-between", overlayHeader && styles.overlay)}>
          <div className={cn("flex min-w-0 items-center gap-1", centeredBotHeader && "z-10 col-start-1 row-start-1 justify-self-start", styles.controls)}>
            <button onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-muted hover:bg-hover md:hidden" aria-label="Open sidebar">
              <MenuIcon className="h-5 w-5" />
            </button>
            {target?.kind === "group" ? (
              <GroupHeader group={target} />
            ) : !centeredBotHeader && (
              <TargetPicker
                value={target}
                apps={apps}
                bots={bots}
                locked={started && target?.kind === "bot"}
                onChange={(t) => {
                  if (embedded || (!started && t.kind === "app")) setTarget(t);
                  else router.push(t.kind === "bot" ? `/?bot=${t.id}` : `/?app=${t.id}`);
                }}
              />
            )}
          </div>
          <div className={cn("flex shrink-0 items-center gap-1", centeredBotHeader && "z-10 col-start-2 row-start-1 justify-self-end", styles.controls)}>
            {target?.kind === "bot" && !embedded && <BotChatNavigation botId={target.id} isHome={isBotHome} conversationId={conversationId} onNewHome={() => void executeCommand("/new", [])} />}
            {target?.kind === "bot" && !embedded && (usesWorkspace || workspaceRunning) && (
              <button
                onClick={openDetails}
                className={cn("rounded-lg p-2 hover:bg-hover", workspaceRunning ? "text-working" : "text-muted")}
                aria-label={workspaceRunning ? `${target.name}'s workspace is busy` : `${target.name}'s workspace`}
                title={workspaceRunning ? "Working in the workspace" : "Workspace"}
              >
                <Monitor className={cn("h-4 w-4", workspaceRunning && "motion-safe:animate-pulse")} />
              </button>
            )}
            {started && !embedded && <ShareButton conversationId={conversationId} />}
            {target?.kind === "bot" && !embedded && (
              <Tip label={detailsLabel}>
                <button
                  ref={detailsToggleRef}
                  onClick={detailsView ? closeDetails : openDetails}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"
                  aria-label={detailsLabel}
                  aria-expanded={detailsView !== null}
                  aria-controls={controlledDetailsId}
                >
                  {detailsView ? <PanelRightClose aria-hidden className="h-5 w-5" /> : <PanelRightOpen aria-hidden className="h-5 w-5" />}
                </button>
              </Tip>
            )}
            <button onClick={() => router.push("/")} className={`rounded-lg p-2 text-muted hover:bg-hover md:hidden ${target?.kind === "bot" ? "hidden" : ""}`} aria-label="New chat">
              <SquarePen className="h-5 w-5" />
            </button>
          </div>
          {centeredBotHeader && <BotHeader bot={target} state={botState} status={botStatusText} />}
        </header>

        {(!target || unavailable) && <div role="status" className="mx-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <p>{unavailableReason ?? (unavailable ? "This chat’s bot or model is unavailable. Your saved messages are still here." : "No models are available for New Chat. Ask an admin to add a model connection, or use a bot.")}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            <Link href="/bots" className="underline">Browse bots</Link>
            {user.canCreateBots && <Link href="/bots/new" className="underline">Create a bot</Link>}
            <Link href="/settings" className="underline">Choose a default model</Link>
            {user.isAdmin && <Link href="/admin/apps" className="underline">Manage connections</Link>}
          </div>
        </div>}
        {target?.kind === "bot" && !embedded && <PetChatActivity
          key={`${user.id}:${target.id}`}
          botId={target.id} conversationId={conversationId} status={status} unavailable={unavailable}
          approval={messages.at(-1)?.role === "assistant" && messages.at(-1)!.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested") || false}
          failed={!!error || (messages.at(-1)?.role === "assistant" && messages.at(-1)!.parts.some((p) => p.type === "data-run-error" || p.type === "data-bot-error")) || false}
        />}

        {target?.kind === "bot" && target.hermesTeam && !embedded && <HermesTeamChatControls key={`${target.id}:${conversationId}`} botId={target.id} conversationId={conversationId} started={started} busy={busy} />}
        {started && hermes && target?.kind === "bot" && !embedded && <HermesNativeControls key={conversationId} conversationId={conversationId} />}

        {empty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-6 pb-[12vh]">
            <div className="my-auto w-full max-w-3xl shrink-0">
              {target?.kind === "group" ? (
                <div className="mb-8 flex flex-col items-center text-center">
                  <div className="mb-3 flex -space-x-3">
                    {target.members?.map((m) => (
                      <span key={m.id} className="rounded-full bg-bg p-0.5">
                        <BotAvatar botId={m.id} value={m.icon} size={48} className="h-12 w-12" />
                      </span>
                    ))}
                  </div>
                  <h1 className="text-2xl font-semibold">{target.name}</h1>
                  <p className="mt-2 max-w-lg text-sm text-muted">
                    Type <span className="font-mono">@</span> to address a bot, or just write — {target.members?.[0]?.name ?? "the lead"} picks
                    up anything that isn&apos;t addressed. Bots can hand work to each other with @mentions.
                  </p>
                </div>
              ) : target?.kind === "bot" ? (
                <div className={cn("flex flex-col items-center text-center", (!centeredBotHeader || target.description) && "mb-8")}>
                  {!centeredBotHeader && <>
                    <BotAvatar botId={target.id} value={target.icon} size={112} state="idle" className="mb-4 h-28 w-28" />
                    <h1 className="max-w-full text-2xl font-semibold wrap-anywhere">{target.name}</h1>
                    {target.label && <span className="mt-1 max-w-full rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted wrap-anywhere">{target.label}</span>}
                  </>}
                  {target.description && <p className="mt-2 max-w-lg text-sm text-muted wrap-anywhere">{target.description}</p>}
                </div>
              ) : (
                <h1 className="mb-8 text-center text-[28px] font-normal">{branding.welcomeText}</h1>
              )}
              {commandResult && <CommandResultCard result={commandResult} onClose={() => setCommandOutput(null)} />}
              <Composer
                tools={target && <NativeSearchControl key={`${target.kind}:${target.id}`} target={target} conversationId={conversationId} started={started} busy={busy} onChange={searchChanged} />}
                ref={composerRef}
                onSend={send}
                onStop={stopReply}
                voiceTarget={voiceTarget}
                busy={busy}
                disabled={!target || unavailable || searchPending}
                skills={skills}
                hermesCommands={hermesCommands}
                commands={composerCommandList}
                autoFocus
                mentions={mentionList}
                tint={tint}
                placeholder={target ? (target.kind === "app" ? "Ask anything" : `Message ${target.name}`) : "Select a model or browse bots"}
              />
              {target?.kind === "bot" && !!target.starters?.length && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {target.starters.map((s) => (
                    <button key={s} onClick={() => send(s, [])} className="rounded-full border border-border px-4 py-2 text-sm text-muted hover:bg-hover hover:text-fg">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              className={cn("relative min-h-0 flex-1 overflow-y-auto", overlayHeader && styles.scroller)}
              onScroll={(e) => {
                const el = e.currentTarget;
                setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
              }}
            >
              <div className={cn("mx-auto w-full max-w-3xl px-4 pb-8 pt-4 md:px-6", bubbles ? "space-y-3" : "space-y-6", overlayHeader && styles.messages)}>
                <DelegatedApprovals conversationId={conversationId} />
                {messages.map((m, i) => [
                  <TimeDivider key={`t-${m.id}`} at={m.metadata?.createdAt} previous={i > 0 ? messages[i - 1].metadata?.createdAt : undefined} />,
                  m.role === "user" ? (
                    <UserMessage key={m.id} message={m} branch={branchInfo(m, i)} onEdit={busy || unavailable || searchPending ? undefined : (t) => editMessage(i, t)} variant={variant} tint={tint} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      variant={variant}
                      message={m}
                      readOnly={unavailable || searchPending}
                      streaming={busy && i === messages.length - 1}
                      isLast={i === lastAssistantIdx}
                      branch={branchInfo(m, i)}
                      botName={botName}
                      avatar={target?.kind === "bot" ? { botId: target.id, value: target.icon } : undefined}
                      feedback={feedback[m.id]}
                      onFeedback={(v) => {
                        setFeedback((f) => ({ ...f, [m.id]: v }));
                        void setMessageFeedback(conversationId, m.id, v);
                      }}
                      onRegenerate={
                        busy || unavailable || searchPending
                          ? undefined
                          : () => {
                              if (searchPendingRef.current) return;
                              keepCurrentBranch();
                              regenerate({ messageId: m.id, body: targetBody });
                            }
                      }
                      onApprove={unavailable ? () => {} : approve}
                      onDeny={unavailable ? () => {} : deny}
                      onAlwaysAllow={target?.kind === "bot" ? alwaysAllow : undefined}
                    />
                  ),
                ])}
                {bubbles && busy && botState === "thinking" && (
                  <BotThinking botId={target?.kind === "bot" ? target.id : undefined} avatar={target?.kind === "group" ? undefined : target?.icon}
                    indented={target?.kind === "bot" && messages.at(-1)?.role === "assistant" && hasContent(messages.at(-1)!)} />
                )}
                {!bubbles && status === "submitted" && messages[messages.length - 1]?.role === "user" && <span className="streaming-dot" />}
                {error && status === "error" && (
                  <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                    {errorText(error)}{" "}
                    {/Connected accounts/.test(errorText(error)) && (
                      <Link href="/settings?tab=connected-accounts" className="mr-2 underline">
                        Open settings
                      </Link>
                    )}
                    <button disabled={unavailable || searchPending} className="underline disabled:opacity-50" onClick={() => { if (!searchPendingRef.current) regenerate({ body: targetBody }); }}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-3xl px-4 pb-3 md:px-6">
              {/* Replies fade out under the composer instead of colliding with it. */}
              <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-bg to-transparent" />
              {!atBottom && (
                <button
                  onClick={() => {
                    const el = scrollRef.current;
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }}
                  className="absolute -top-12 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-bg shadow"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              )}
              {commandResult && <CommandResultCard result={commandResult} onClose={() => setCommandOutput(null)} />}
              <Composer
                tools={target && <NativeSearchControl key={`${target.kind}:${target.id}`} target={target} conversationId={conversationId} started={started} busy={busy} onChange={searchChanged} />}
                ref={composerRef}
                onSend={send}
                onStop={stopReply}
                voiceTarget={voiceTarget}
                busy={busy}
                disabled={!target || unavailable || searchPending}
                skills={skills}
                hermesCommands={hermesCommands}
                commands={composerCommandList}
                mentions={mentionList}
                tint={tint}
                placeholder={target?.kind === "group" || target?.kind === "bot" ? `Message ${target.name}` : "Ask anything"}
              />
              <p className="mt-2 text-center text-xs text-subtle">AI can make mistakes. Check important info.</p>
            </div>
          </>
        )}
      </div>
      {target?.kind === "bot" && !embedded && (
        <div id={detailsId} onFocusCapture={(event) => { detailsFocusRef.current = event.target; }} hidden={detailsView !== "desktop"}>
          {detailsView === "desktop" && <BotSidePanel bot={target} onClose={closeDetails} panelId={detailsId} />}
        </div>
      )}
      {target?.kind === "bot" && !embedded && <Dialog open={detailsView === "mobile"} onOpenChange={(open) => { if (!open) setDetailsView(null); }}>
        <DialogContent title={`${target.name} activity`} description="Recent activity, outputs and routines" className="p-2" hideClose onCloseAutoFocus={(event) => { event.preventDefault(); detailsToggleRef.current?.focus(); }}>
          <div id={`${detailsId}-mobile`} onFocusCapture={(event) => { detailsFocusRef.current = event.target; }} className="h-[70vh]"><BotSidePanel mobile bot={target} onClose={closeDetails} panelId={`${detailsId}-mobile`} /></div>
        </DialogContent>
      </Dialog>}
    </div>
  );
}

/** Center on the conversation pane; narrow panes give the controls their own row. */
function BotHeader({ bot, state, status }: { bot: TargetOption; state: BlobState; status: string | null }) {
  return (
    <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-col items-center gap-1 px-2 text-center @min-[50rem]/chat-pane:row-start-1">
      {/* Scale the whole avatar so sprite cells and emoji fallbacks keep their proportions. */}
      <div className={cn("h-16 w-16 @min-[36rem]/chat-pane:h-[84px] @min-[36rem]/chat-pane:w-[84px]", styles.avatar)}>
        <BotAvatar botId={bot.id} value={bot.icon} size={84} state={state} className="origin-top-left scale-[0.761905] @min-[36rem]/chat-pane:scale-100" />
      </div>
      <div className={cn("w-full min-w-0 max-w-lg leading-tight", styles.identity)}>
        <h1 title={bot.name} className="truncate text-[15px] font-medium">{bot.name}</h1>
        <div title={status ?? bot.label ?? undefined} aria-live="polite" className={cn("truncate text-xs", state === "waiting" ? "text-warn" : state === "idle" ? "text-subtle" : "text-working")}>
          {status ?? bot.label ?? "Ready"}
        </div>
      </div>
    </div>
  );
}

/** Shown while a bot is getting started on a reply: its avatar glances around instead of typing dots. */
/** `indented`: the reply above already shows the bot's avatar, so this row lines up under it instead of repeating it. */
function BotThinking({ avatar, botId, indented }: { avatar?: string | null; botId?: string; indented?: boolean }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted">
      {indented ? <span aria-hidden className="w-7 shrink-0" /> : <BotAvatar botId={botId} value={avatar} size={28} state="thinking" className="h-7 w-7" />}
      <span className="motion-safe:animate-pulse">Thinking…</span>
    </div>
  );
}

/** A centred time between messages that are far apart (and before the first), like Grok Bot and ChatGPT desktop. */
function TimeDivider({ at, previous }: { at?: number; previous?: number }) {
  if (!at || at === Number.MAX_SAFE_INTEGER || (previous && at - previous < 30 * 60_000)) return null;
  const d = new Date(at);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = d.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
  const day =
    at >= startOfToday ? "Today" : at >= startOfToday - 86_400_000 ? "Yesterday" : at >= startOfToday - 6 * 86_400_000 ? d.toLocaleDateString("en", { weekday: "long" }) : d.toLocaleDateString("en", { month: "short", day: "numeric" });
  return (
    <div suppressHydrationWarning className="pt-1 text-center text-xs text-subtle">
      {day} {time}
    </div>
  );
}

function GroupHeader({ group }: { group: TargetOption }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      <div className="flex -space-x-2">
        {group.members?.slice(0, 4).map((m) => (
          <span key={m.id} className="rounded-full bg-bg p-px" title={m.name}>
            <BotAvatar botId={m.id} value={m.icon} size={24} className="h-6 w-6" />
          </span>
        ))}
      </div>
      <span className="truncate text-lg font-medium">{group.name}</span>
    </div>
  );
}

/** The server's own message (JSON {error} from the chat API, or the stream's error text), else a generic one. */
function errorText(err: Error): string {
  const raw = err.message?.trim() ?? "";
  try {
    const j = JSON.parse(raw) as { error?: unknown };
    if (typeof j?.error === "string" && j.error) return j.error;
  } catch {
    if (raw && raw.length <= 400 && !raw.startsWith("<")) return raw;
  }
  return "Something went wrong.";
}

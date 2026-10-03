import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./helpers/mock-llm";

// Keep turns self-contained: no embedding app (memory selection falls back to recent memories).
vi.mock("@/lib/llm/apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/apps")>()),
  embeddingApp: async () => undefined,
}));

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise.
const run = process.env.DATABASE_URL ? describe : describe.skip;

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
}

run("Sign in with ChatGPT (integration, against the mock sign-in and Codex backend)", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let savedSettings: unknown;
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `it-cgpt-${suffix}`;
  const otherId = `it-cgpt-other-${suffix}`;
  const appId = `it-cgpt-app-${suffix}`;

  const principalOf = async (id: string) => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return { user, groupIds: [], isAdmin: false, canCreateBots: true };
  };

  /** Test controls of the mock sign-in service (dev/mock-llm/chatgpt-auth.mjs). */
  const mockControl = (c: Record<string, unknown>) =>
    fetch(`${mock.url}/__mock/chatgpt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
  const expireToken = async (id: string, inMs = -1000) => {
    const { db } = await import("@/db");
    const { userCredentials } = await import("@/db/schema");
    await db.update(userCredentials).set({ expiresAt: new Date(Date.now() + inMs) }).where(eq(userCredentials.userId, id));
  };

  /** Connects `id` through the device flow (first poll pending, second approved). */
  async function connect(id: string) {
    const { db } = await import("@/db");
    const { chatgptDeviceLogins } = await import("@/db/schema");
    const { startChatGPTDeviceLogin, pollChatGPTDeviceLogin } = await import("@/lib/llm/chatgpt/device");
    const p = await principalOf(id);
    const started = await startChatGPTDeviceLogin(p);
    expect(started.userCode).toMatch(/^MOCK-/);
    expect(started.verificationUrl).toBe(`${mock.url}/codex/device`);

    // The server enforces the poll interval: an early poll doesn't reach the sign-in service.
    expect(await pollChatGPTDeviceLogin(p)).toEqual({ status: "pending", intervalSec: 3 });
    const due = () => db.update(chatgptDeviceLogins).set({ nextPollAt: new Date(Date.now() - 1000) }).where(eq(chatgptDeviceLogins.userId, id));
    await due();
    expect((await pollChatGPTDeviceLogin(p)).status).toBe("pending"); // the mock's first answer is 403 pending
    await due();
    return pollChatGPTDeviceLogin(p);
  }

  beforeAll(async () => {
    mock = await startMockLlm();
    process.env.CHATGPT_AUTH_BASE_URL = mock.url;
    process.env.CHATGPT_BACKEND_URL = `${mock.url}/backend-api`;
    const { db } = await import("@/db");
    const { aiApps, settings, users } = await import("@/db/schema");
    const { setSetting } = await import("@/lib/settings");
    [savedSettings] = await db.select().from(settings).where(eq(settings.key, "chatgpt"));
    await db.insert(users).values([
      { id: userId, upn: `${userId}@corp.local`, name: "ChatGPT Test", authSource: "ldap" },
      { id: otherId, upn: `${otherId}@corp.local`, name: "Other Test", authSource: "ldap" },
    ]);
    await setSetting("chatgpt", {
      enabled: true,
      access: "everyone",
      allowedGroupIds: [],
      allowedUpns: [],
      allowedWorkspaceIds: [],
      allowPersonalPlans: false,
      allowBackground: false,
    });
    await db.insert(aiApps).values({ id: appId, name: "IT ChatGPT", provider: "chatgpt", credentialMode: "user", model: "mock-codex", supportsTools: true });
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { aiApps, settings, usageEvents, users } = await import("@/db/schema");
    await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
    await db.delete(aiApps).where(eq(aiApps.id, appId));
    await db.delete(users).where(eq(users.id, userId)); // cascades to credentials, device logins, conversations
    await db.delete(users).where(eq(users.id, otherId));
    await db.delete(settings).where(eq(settings.key, "chatgpt"));
    if (savedSettings) await db.insert(settings).values(savedSettings as typeof settings.$inferInsert);
    await pool.end();
    mock?.stop();
    delete process.env.CHATGPT_AUTH_BASE_URL;
    delete process.env.CHATGPT_BACKEND_URL;
  });

  it("rejects a personal plan unless the admin allows personal plans, and stores nothing", { timeout: 30_000 }, async () => {
    const { getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    const r = await connect(userId);
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { error: string }).error).toMatch(/Personal ChatGPT plans \(Plus\)/);
    expect(await getChatGPTCredential(userId)).toBeUndefined();
  });

  it("connects, stores tokens encrypted, and chats on the plan through the agent loop", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { aiApps, conversations, messages, usageEvents, userCredentials } = await import("@/db/schema");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { newId } = await import("@/lib/ids");
    const { insertMessage } = await import("@/lib/chat/store");
    const { runTurn } = await import("@/lib/agent/run");
    const { openCredentialSecret } = await import("@/lib/llm/chatgpt/store");
    await setSetting("chatgpt", { ...(await getSetting("chatgpt")), allowPersonalPlans: true });

    const r = await connect(userId);
    expect(r).toMatchObject({ status: "connected", connection: { planType: "plus", accountId: "acct-mock" } });
    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
    expect(cred).toMatchObject({ provider: "chatgpt", status: "active", accountId: "acct-mock", planType: "plus" });
    const secret = openCredentialSecret(cred);
    expect(secret.refresh).toMatch(/^rt_mock_/);
    expect(cred.secretEnc).not.toContain(secret.access);
    expect(cred.secretEnc).not.toContain(secret.refresh);

    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
    const [conversation] = await db.insert(conversations).values({ id: newId(), userId, appId, title: "IT" }).returning();
    const userMsg = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "Hello from my plan" }] };
    await insertMessage(conversation.id, userMsg, null);
    const principal = await principalOf(userId);
    const turn = await runTurn({ principal, conversation, app, bot: null, history: [userMsg], continuation: false });
    await drain(turn.stream);
    const done = await turn.done;
    expect(done.error).toBeUndefined();
    const text = done.responseMessage.parts.map((p) => ("text" in p ? p.text : "")).join("");
    expect(text).toContain('You said: "Hello from my plan"');

    const [row] = await db.select().from(messages).where(eq(messages.id, done.responseMessage.id));
    expect(row).toMatchObject({ billingSource: "chatgpt_plan", providerKind: "chatgpt", appId });
    const { chatgptReplayKey } = await import("@/lib/llm/resolve");
    // Sealed reasoning is tied to this connection and ChatGPT account (see src/lib/agent/replay.ts).
    expect(row.metadata).toMatchObject({ appId, providerKind: "chatgpt", replayKey: chatgptReplayKey(cred.id, cred.accountId) });
    const events = await db.select().from(usageEvents).where(eq(usageEvents.messageId, done.responseMessage.id));
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) expect(e).toMatchObject({ billingSource: "chatgpt_plan", credentialId: cred.id, providerKind: "chatgpt", purpose: "chat" });

    // Plan usage reported by the backend is kept (percentages only).
    await vi.waitFor(async () => {
      const [c] = await db.select().from(userCredentials).where(eq(userCredentials.id, cred.id));
      expect(c.rateLimits).toMatchObject({ primary: { usedPercent: 12.5, windowMinutes: 300 }, secondary: { usedPercent: 3, windowMinutes: 10080 } });
    });
  });

  it("a rejected access token is refreshed once (rotating the refresh token) and the request retried", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { aiApps, conversations, userCredentials } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { runTurn } = await import("@/lib/agent/run");
    const { openCredentialSecret, sealCredentialSecret } = await import("@/lib/llm/chatgpt/store");

    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
    const before = openCredentialSecret(cred);
    // Still "fresh" by its expiry, but the backend no longer accepts it.
    await db
      .update(userCredentials)
      .set({ secretEnc: sealCredentialSecret(cred.id, { ...before, access: "revoked-access-token" }) })
      .where(eq(userCredentials.id, cred.id));

    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
    const [conversation] = await db.insert(conversations).values({ id: newId(), userId, appId, title: "IT 401" }).returning();
    const userMsg = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "after a 401" }] };
    const turn = await runTurn({ principal: await principalOf(userId), conversation, app, bot: null, history: [userMsg], continuation: false });
    await drain(turn.stream);
    const done = await turn.done;
    expect(done.error).toBeUndefined();
    expect(done.responseMessage.parts.map((p) => ("text" in p ? p.text : "")).join("")).toContain("after a 401");

    const [after] = await db.select().from(userCredentials).where(eq(userCredentials.id, cred.id));
    const s = openCredentialSecret(after);
    expect(s.access).not.toBe("revoked-access-token");
    expect(s.refresh).not.toBe(before.refresh);
    expect(after.status).toBe("active");
  });

  it("concurrent refreshes of an expiring token make one upstream refresh", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { userCredentials } = await import("@/db/schema");
    const { getChatGPTAuth, openCredentialSecret } = await import("@/lib/llm/chatgpt/store");
    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
    await db.update(userCredentials).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(userCredentials.id, cred.id));

    let refreshes = 0;
    const counting: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/oauth/token")) refreshes++;
      return fetch(input, init);
    };
    const results = await Promise.all([1, 2, 3].map(() => getChatGPTAuth(userId, { fetch: counting })));
    expect(refreshes).toBe(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
    const [after] = await db.select().from(userCredentials).where(eq(userCredentials.id, cred.id));
    expect(openCredentialSecret(after).access).toBe(results[0].accessToken);
    // Fresh now: no further refresh.
    await getChatGPTAuth(userId, { fetch: counting });
    expect(refreshes).toBe(1);
  });

  it("usage limits and background use give clear, non-retried errors", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { aiApps, conversations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { runTurn } = await import("@/lib/agent/run");
    const { resolveModel, utilityApp } = await import("@/lib/llm");
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
    const principal = await principalOf(userId);

    const [conversation] = await db.insert(conversations).values({ id: newId(), userId, appId, title: "IT limit" }).returning();
    const userMsg = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "[limit] one more" }] };
    const turn = await runTurn({ principal, conversation, app, bot: null, history: [userMsg], continuation: false });
    const chunks: { type: string; errorText?: string }[] = [];
    const reader = turn.stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value as never);
    const err = chunks.find((c) => c.type === "error");
    expect(err?.errorText).toMatch(/reached your ChatGPT plan's usage limit/);

    await expect(resolveModel(app, { purpose: "chat", principal, background: true })).rejects.toThrow(/routines can't use/);
    await expect(resolveModel(app, { purpose: "title", principal })).rejects.toThrow(/background work/);
    expect(await utilityApp(app)).not.toEqual(expect.objectContaining({ id: appId }));
    // Someone who never connected is told to connect.
    await expect(resolveModel(app, { purpose: "chat", principal: await principalOf(otherId) })).rejects.toThrow(/Connect your ChatGPT account/);
  });

  it("a refresh without an id token keeps the account's FedRAMP and residency facts", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { userCredentials } = await import("@/db/schema");
    const { getChatGPTAuth } = await import("@/lib/llm/chatgpt/store");
    const row = async () => (await db.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0];
    try {
      // A normal refresh brings an id token carrying FedRAMP and residency (id-token claims)…
      await mockControl({ refreshMode: "normal", fedramp: true, residency: "eu" });
      await expireToken(userId);
      expect(await getChatGPTAuth(userId)).toMatchObject({ isFedramp: true, residency: "eu" });
      expect(await row()).toMatchObject({ isFedramp: true, residency: "eu" });
      // …and a later refresh that returns no id token must not wipe them.
      await mockControl({ refreshMode: "no-id-token" });
      await expireToken(userId);
      expect(await getChatGPTAuth(userId)).toMatchObject({ isFedramp: true, residency: "eu" });
      expect(await row()).toMatchObject({ isFedramp: true, residency: "eu", status: "active" });
    } finally {
      await mockControl({ refreshMode: "normal", fedramp: false, residency: null });
    }
  });

  it("a failing sign-in service doesn't stop turns while the token still works", { timeout: 30_000 }, async () => {
    const { getChatGPTAuth, openCredentialSecret, getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    const { ChatGPTUnavailableError } = await import("@/lib/llm/chatgpt/errors");
    let refreshes = 0;
    const counting: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/oauth/token")) refreshes++;
      return fetch(input, init);
    };
    try {
      await mockControl({ refreshMode: "unavailable" });
      await expireToken(userId, 60_000); // inside the refresh window, still valid
      const current = openCredentialSecret((await getChatGPTCredential(userId))!).access;
      expect((await getChatGPTAuth(userId, { fetch: counting })).accessToken).toBe(current);
      expect(refreshes).toBe(1);
      // Cooling down: the still-valid token is used without asking the sign-in service again.
      expect((await getChatGPTAuth(userId, { fetch: counting })).accessToken).toBe(current);
      expect(refreshes).toBe(1);
      // Once it has actually expired, the person is told the service is unavailable.
      await expireToken(userId);
      await expect(getChatGPTAuth(userId, { fetch: counting })).rejects.toBeInstanceOf(ChatGPTUnavailableError);
    } finally {
      await mockControl({ refreshMode: "normal" });
    }
    expect((await getChatGPTAuth(userId)).accessToken).toBeTruthy();
  });

  it("a refresh reply with only a new refresh token keeps it, so the next refresh doesn't reuse the spent one", { timeout: 30_000 }, async () => {
    const { getChatGPTAuth, openCredentialSecret, getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    const before = openCredentialSecret((await getChatGPTCredential(userId))!);
    try {
      await mockControl({ refreshMode: "refresh-only" });
      await expireToken(userId);
      await expect(getChatGPTAuth(userId)).rejects.toThrow(/temporarily unavailable/);
      const kept = openCredentialSecret((await getChatGPTCredential(userId))!);
      expect(kept.refresh).not.toBe(before.refresh);
    } finally {
      await mockControl({ refreshMode: "normal" });
    }
    // The rotated refresh token works (the spent one would have been refresh_token_reused and revoked everything).
    await getChatGPTAuth(userId);
    expect(await getChatGPTCredential(userId)).toMatchObject({ status: "active" });
  });

  it("a sign-in cancelled while its poll is in flight is never completed", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { chatgptDeviceLogins } = await import("@/db/schema");
    const { startChatGPTDeviceLogin, pollChatGPTDeviceLogin, cancelChatGPTDeviceLogin } = await import("@/lib/llm/chatgpt/device");
    const { getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    const p = await principalOf(otherId);
    const first = await startChatGPTDeviceLogin(p);
    // Starting again while one is in progress reuses it (same code, no new request to OpenAI).
    expect((await startChatGPTDeviceLogin(p)).userCode).toBe(first.userCode);
    const due = () => db.update(chatgptDeviceLogins).set({ nextPollAt: new Date(Date.now() - 1000) }).where(eq(chatgptDeviceLogins.userId, otherId));
    await due();
    expect((await pollChatGPTDeviceLogin(p)).status).toBe("pending");
    await due();
    // The person cancels while the (approving) upstream poll is still running.
    const cancelMidPoll: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/deviceauth/token")) await cancelChatGPTDeviceLogin(otherId);
      return fetch(input, init);
    };
    expect(await pollChatGPTDeviceLogin(p, cancelMidPoll)).toEqual({ status: "none" });
    expect(await getChatGPTCredential(otherId)).toBeUndefined();
  });

  it("two tabs starting at once get the same code, and a key-rotation rewrap mid-poll doesn't lose the sign-in", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { chatgptDeviceLogins } = await import("@/db/schema");
    const { AAD, decrypt, encrypt } = await import("@/lib/crypto");
    const { startChatGPTDeviceLogin, pollChatGPTDeviceLogin, cancelChatGPTDeviceLogin } = await import("@/lib/llm/chatgpt/device");
    const { deleteChatGPTConnection, getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    await cancelChatGPTDeviceLogin(otherId);
    const p = await principalOf(otherId);
    const [a, b] = await Promise.all([startChatGPTDeviceLogin(p), startChatGPTDeviceLogin(p)]);
    expect(a.userCode).toBe(b.userCode);

    const due = () => db.update(chatgptDeviceLogins).set({ nextPollAt: new Date(Date.now() - 1000) }).where(eq(chatgptDeviceLogins.userId, otherId));
    await due();
    expect((await pollChatGPTDeviceLogin(p)).status).toBe("pending");
    await due();
    // The worker re-encrypts pending sign-ins after a key rotation (new ciphertext, same sign-in) during the poll.
    const rewrapMidPoll: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/deviceauth/token")) {
        const aad = `${AAD.chatgptDeviceAuth}|${otherId}`;
        const [row] = await db.select().from(chatgptDeviceLogins).where(eq(chatgptDeviceLogins.userId, otherId));
        await db.update(chatgptDeviceLogins).set({ deviceAuthEnc: encrypt(decrypt(row.deviceAuthEnc, aad), aad) }).where(eq(chatgptDeviceLogins.userId, otherId));
      }
      return fetch(input, init);
    };
    expect(await pollChatGPTDeviceLogin(p, rewrapMidPoll)).toMatchObject({ status: "connected" });
    expect(await getChatGPTCredential(otherId)).toMatchObject({ status: "active" });
    await deleteChatGPTConnection(otherId);
  });

  it("a disabled person can't end up connected", async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { saveChatGPTConnection, ChatGPTUserDisabledError, getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    await db.update(users).set({ disabled: true }).where(eq(users.id, otherId));
    try {
      await expect(
        saveChatGPTConnection(
          otherId,
          { accessToken: "a", refreshToken: "r" },
          { accountId: "acct-other", planType: "plus", userId: "subject-other", email: null, isFedramp: false, residency: null, expiresAt: null },
        ),
      ).rejects.toBeInstanceOf(ChatGPTUserDisabledError);
      expect(await getChatGPTCredential(otherId)).toBeUndefined();
    } finally {
      await db.update(users).set({ disabled: false }).where(eq(users.id, otherId));
    }
  });

  it("a group turn goes on when a ChatGPT-plan bot can't answer", { timeout: 60_000 }, async () => {
    const { db } = await import("@/db");
    const { aiApps, bots, conversationBots, conversations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { loadGroupMembers, runGroupTurn } = await import("@/lib/agent/group");
    const companyAppId = `it-cgpt-company-${suffix}`;
    await db.insert(aiApps).values({ id: companyAppId, name: "IT Company", provider: "openai-compatible", baseUrl: `${mock.url}/v1`, model: "mock-gpt" });
    try {
      const [planBot] = await db.insert(bots).values({ ownerId: userId, name: "Planbot", appId, visibility: "org" }).returning();
      const [companyBot] = await db.insert(bots).values({ ownerId: userId, name: "Companybot", appId: companyAppId, visibility: "org" }).returning();
      const [conversation] = await db.insert(conversations).values({ id: newId(), userId: otherId, isGroup: true, title: "IT group" }).returning();
      await db.insert(conversationBots).values([
        { conversationId: conversation.id, botId: planBot.id, position: 0 },
        { conversationId: conversation.id, botId: companyBot.id, position: 1 },
      ]);
      const principal = await principalOf(otherId); // allowed, but has never connected a plan
      const members = await loadGroupMembers(principal, conversation.id);
      expect(members.map((m) => m.bot.name)).toEqual(["Planbot", "Companybot"]);
      const userMsg = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "@Planbot @Companybot hello team" }] };
      const stream = await runGroupTurn({ principal, conversation, members, history: [userMsg] });
      let text = "";
      const notes: { botId: string; message: string }[] = [];
      const reader = stream.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        const c = r.value as { type: string; delta?: string; data?: { botId: string; message: string } };
        expect(c.type).not.toBe("error");
        if (c.type === "text-delta") text += c.delta;
        if (c.type === "data-bot-error") notes.push(c.data!);
      }
      // The failure is its own part (shown under the bot, never replayed to models as the bot's words).
      expect(notes).toEqual([{ botId: planBot.id, message: expect.stringMatching(/^Connect your ChatGPT account/) }]);
      expect(text).not.toContain("Connect your ChatGPT account");
      expect(text).toContain("You said:");

      // After Stop no further bot is started.
      const aborted = new AbortController();
      aborted.abort();
      const stopped = await runGroupTurn({ principal, conversation, members, history: [userMsg], abortSignal: aborted.signal });
      const types: string[] = [];
      const r2 = stopped.getReader();
      for (let r = await r2.read(); !r.done; r = await r2.read()) types.push((r.value as { type: string }).type);
      expect(types).not.toContain("data-speaker");
    } finally {
      await db.delete(aiApps).where(eq(aiApps.id, companyAppId));
    }
  });

  it("the same ChatGPT account can't be shared by two portal users; a spent refresh token needs reconnecting", { timeout: 30_000 }, async () => {
    const { db } = await import("@/db");
    const { userCredentials } = await import("@/db/schema");
    const { ChatGPTAccountInUseError, getChatGPTAuth, openCredentialSecret, saveChatGPTConnection } = await import("@/lib/llm/chatgpt/store");
    const { ChatGPTReauthRequiredError } = await import("@/lib/llm/chatgpt/errors");
    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));

    await expect(
      saveChatGPTConnection(
        otherId,
        { accessToken: "x", refreshToken: "y" },
        { accountId: cred.accountId, planType: "plus", userId: cred.externalSubject, email: null, isFedramp: false, residency: null, expiresAt: null },
      ),
    ).rejects.toBeInstanceOf(ChatGPTAccountInUseError);

    // Reuse detection upstream (refresh_token_reused) marks the connection as needing a new sign-in.
    const s = openCredentialSecret(cred);
    await fetch(`${mock.url}/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: s.refresh }) });
    await db.update(userCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userCredentials.id, cred.id));
    await expect(getChatGPTAuth(userId)).rejects.toBeInstanceOf(ChatGPTReauthRequiredError);
    const [after] = await db.select().from(userCredentials).where(eq(userCredentials.id, cred.id));
    expect(after).toMatchObject({ status: "needs_reauth", statusReason: "refresh_token_reused" });
  });

  it("disconnecting deletes the connection", async () => {
    const { deleteChatGPTConnection, getChatGPTCredential } = await import("@/lib/llm/chatgpt/store");
    expect(await deleteChatGPTConnection(userId)).toBe(true);
    expect(await getChatGPTCredential(userId)).toBeUndefined();
    expect(await deleteChatGPTConnection(userId)).toBe(false);
  });
});

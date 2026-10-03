import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/jobs", async (original) => ({ ...(await original<typeof import("@/lib/jobs")>()), enqueueRun: vi.fn(async () => "mock-job") }));
const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal }));
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("canonical bot home (real Postgres)", () => {
  let alice: Principal;
  let bob: Principal;
  let botId: string;
  let appId: string;
  const userIds: string[] = [];
  const botIds: string[] = [];

  async function newBot(extra = {}) {
    const { db, schema } = await import("@/db");
    const [b] = await db.insert(schema.bots).values({ ownerId: alice.user.id, name: "IT Home bot", appId, visibility: "org", ...extra }).returning();
    botIds.push(b.id);
    return b;
  }

  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    for (const name of ["Alice", "Bob"]) {
      const id = `it-home-${newId()}`;
      const [user] = await db.insert(schema.users).values({ id, upn: `${id}@corp.local`, name, authSource: "ldap" }).returning();
      userIds.push(id);
      const principal = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      if (name === "Alice") alice = principal;
      else bob = principal;
    }
    const [app] = await db.insert(schema.aiApps).values({ name: "IT Home model", model: "mock", baseUrl: "http://localhost:4010/v1" }).returning();
    appId = app.id;
    botId = (await newBot()).id;
  });

  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    await db.delete(schema.bots).where(inArray(schema.bots.id, botIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await pool.end();
  });

  it("24 simultaneous opens return one ID; existing chats, messages and routine results stay untouched", async () => {
    const { db, schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const [legacy, routine] = await db.insert(schema.conversations).values([
      { userId: alice.user.id, botId, title: "Prior separate chat" },
      { userId: alice.user.id, botId, title: "Routine result", source: "routine" },
    ]).returning();
    await db.insert(schema.messages).values({ id: `msg-${legacy.id}`, conversationId: legacy.id, role: "user", parts: [{ type: "text", text: "Private old history" }] });
    const homes = await Promise.all(Array.from({ length: 24 }, () => openBotHome(alice, botId)));
    expect(new Set(homes.map((h) => h.id)).size).toBe(1);
    expect(homes[0]).toMatchObject({ userId: alice.user.id, botId, isBotHome: true, isGroup: false, source: "chat", appId: null });
    expect(homes[0].id).not.toBe(legacy.id);
    expect(await db.select().from(schema.conversations).where(inArray(schema.conversations.id, [legacy.id, routine.id]))).toEqual([legacy, routine]);
    expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, legacy.id))).toHaveLength(1);
    expect(homes.every((h) => +h.updatedAt === +homes[0].updatedAt)).toBe(true);
  });

  it("different users and different bots get isolated homes, even on one shared provider", async () => {
    const { openBotHome } = await import("@/lib/chat/home");
    const a = await openBotHome(alice, botId);
    const b = await openBotHome(bob, botId);
    const c = await openBotHome(alice, (await newBot()).id);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    const { getOwnedConversation } = await import("@/lib/authz");
    await expect(getOwnedConversation(bob, a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("private and group bots require current access; admin opens never use the owner's home", async () => {
    const { openBotHome } = await import("@/lib/chat/home");
    const privateBot = await newBot({ visibility: "private" });
    await expect(openBotHome(bob, privateBot.id)).rejects.toMatchObject({ status: 403 });
    const owner = await openBotHome(alice, privateBot.id);
    const admin = await openBotHome({ ...bob, isAdmin: true }, privateBot.id);
    expect(admin.userId).toBe(bob.user.id);
    expect(admin.id).not.toBe(owner.id);
    const { db, schema } = await import("@/db");
    const [group] = await db.insert(schema.groups).values({ name: `it-home-group-${botId}` }).returning();
    try {
      const restricted = await newBot({ visibility: "groups" });
      await db.insert(schema.botAccess).values({ botId: restricted.id, groupId: group.id });
      await expect(openBotHome(bob, restricted.id)).rejects.toMatchObject({ status: 403 });
      await openBotHome({ ...bob, groupIds: [group.id] }, restricted.id);
      await db.delete(schema.botAccess).where(eq(schema.botAccess.botId, restricted.id));
      await expect(openBotHome({ ...bob, groupIds: [group.id] }, restricted.id)).rejects.toMatchObject({ status: 403 });
    } finally { await db.delete(schema.groups).where(eq(schema.groups.id, group.id)); }
  });

  it("disabled users/bots and deleted bots cannot create or send, without fallback to an app", async () => {
    const { openBotHome } = await import("@/lib/chat/home");
    const { resolveTurnTarget } = await import("@/lib/agent/target");
    const { resolveTargetOption } = await import("@/lib/chat/targets");
    const b = await newBot({ enabled: false });
    await expect(openBotHome(alice, b.id)).rejects.toMatchObject({ status: 403 });
    await expect(resolveTurnTarget(alice, { botId: b.id, appId: null })).rejects.toMatchObject({ status: 403 });
    expect((await resolveTargetOption(alice, { botId: b.id })).target).toBeNull();
    expect((await resolveTargetOption(alice, { appId: null, botId: null, allowDefault: false })).target).toBeNull();
    const { db, schema } = await import("@/db");
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, bob.user.id));
    await expect(openBotHome(bob, botId)).rejects.toMatchObject({ status: 401 });
    await db.update(schema.users).set({ disabled: false }).where(eq(schema.users.id, bob.user.id));
    const deleted = await newBot();
    const home = await openBotHome(alice, deleted.id);
    await db.delete(schema.bots).where(eq(schema.bots.id, deleted.id));
    await expect(openBotHome(alice, deleted.id)).rejects.toMatchObject({ status: 403 });
    const [saved] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, home.id));
    expect(saved).toMatchObject({ botId: null, isBotHome: true });
  });

  it("archiving retires the identity; unarchive preserves that chat and never replaces the new home", async () => {
    const { openBotHome } = await import("@/lib/chat/home");
    const { archiveConversation } = await import("@/app/(chat)/actions");
    session.principal = alice;
    const b = await newBot();
    const old = await openBotHome(alice, b.id);
    await archiveConversation(old.id);
    const home = await openBotHome(alice, b.id);
    expect(home.id).not.toBe(old.id);
    await archiveConversation(old.id, false);
    expect((await openBotHome(alice, b.id)).id).toBe(home.id);
    const { db, schema } = await import("@/db");
    const [saved] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, old.id));
    expect(saved).toMatchObject({ archived: false, isBotHome: false });
  });

  it("archive/open and delete/open races keep at most one active home and can reopen afterwards", async () => {
    const { openBotHome } = await import("@/lib/chat/home");
    const { archiveConversation, deleteConversation } = await import("@/app/(chat)/actions");
    const { db, schema } = await import("@/db");
    session.principal = alice;
    const b = await newBot();
    for (let n = 0; n < 5; n++) {
      const old = await openBotHome(alice, b.id);
      await Promise.all([archiveConversation(old.id), ...Array.from({ length: 8 }, () => openBotHome(alice, b.id))]);
      const [saved] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, old.id));
      expect(saved).toMatchObject({ archived: true, isBotHome: false });
      const home = await openBotHome(alice, b.id);
      await Promise.all([deleteConversation(home.id), ...Array.from({ length: 8 }, () => openBotHome(alice, b.id))]);
      await openBotHome(alice, b.id);
      const homes = await db.select().from(schema.conversations).where(and(eq(schema.conversations.userId, alice.user.id), eq(schema.conversations.botId, b.id), eq(schema.conversations.isBotHome, true)));
      expect(homes).toHaveLength(1);
      expect(homes[0].archived).toBe(false);
    }
  });

  it("database rejects a second home, archived home, group home, or routine home", async () => {
    const { db, schema } = await import("@/db");
    for (const extra of [{}, { archived: true }, { isGroup: true }, { source: "routine" as const }]) {
      await expect(db.insert(schema.conversations).values({ userId: alice.user.id, botId, isBotHome: true, ...extra })).rejects.toThrow();
    }
  });
  it("24 /new requests from two tabs rotate a home once, keep its transcript and memory, and date the retired work", async () => {
    const { db, schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const { freshConversation } = await import("@/lib/chat/fresh");
    const { newId } = await import("@/lib/ids");
    const b = await newBot();
    const source = await openBotHome(alice, b.id);
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await db.insert(schema.messages).values({ id: newId(), conversationId: source.id, role: "user", parts: [{type:"text",text:"Keep my transcript"}] });
    const [memory] = await db.insert(schema.memories).values({ userId: alice.user.id, botId: b.id, content: "Keeps bullet summaries" }).returning();
    await db.update(schema.conversations).set({ updatedAt: new Date("2025-01-01") }).where(eq(schema.conversations.id, source.id));
    const results = await Promise.all(Array.from({length:24}, () => freshConversation(alice, {conversationId:source.id,bot:b,app}, newId())));
    expect(new Set(results.map(r=>r.id)).size).toBe(1);
    expect((await openBotHome(alice,b.id)).id).toBe(results[0].id);
    const [saved] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, source.id));
    expect(saved).toMatchObject({isBotHome:false,archived:false,homeSuccessorId:results[0].id});
    expect(+saved.updatedAt).toBeGreaterThan(Date.now()-60_000);
    expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, source.id))).toHaveLength(1);
    expect((await db.select().from(schema.memories).where(eq(schema.memories.id,memory.id)))[0]).toEqual(memory);
    const second = await freshConversation(alice,{conversationId:results[0].id,bot:b,app},newId());
    expect(second.id).not.toBe(results[0].id);
    expect((await freshConversation(alice,{conversationId:source.id,bot:b,app},newId())).id).toBe(results[0].id);
    expect((await openBotHome(alice,b.id)).id).toBe(second.id);
  });

  it("/new rejects queued/running/approval and unconfirmed cancellation without changing identity", async () => {
    const { db,schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const { freshConversation } = await import("@/lib/chat/fresh");
    const { newId } = await import("@/lib/ids");
    const b=await newBot();const home=await openBotHome(alice,b.id);
    const [app]=await db.select().from(schema.aiApps).where(eq(schema.aiApps.id,appId));
    for(const status of ["queued","running","waiting"] as const){
      const [run]=await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,messageId:newId(),botId:b.id,appId,status}).returning();
      const next=newId();
      await expect(freshConversation(alice,{conversationId:home.id,bot:b,app},next)).rejects.toMatchObject({status:409});
      expect(await db.select().from(schema.conversations).where(eq(schema.conversations.id,next))).toHaveLength(0);
      expect((await openBotHome(alice,b.id)).id).toBe(home.id);
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id,run.id));
    }
    const [run]=await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,messageId:newId(),botId:b.id,appId,status:"cancelled"}).returning();
    await db.insert(schema.hermesRunContexts).values({runId:run.id,targetKey:"test",stopState:"pending"});
    await expect(freshConversation(alice,{conversationId:home.id,bot:b,app},newId())).rejects.toMatchObject({status:409});
    await db.update(schema.hermesRunContexts).set({stopState:"confirmed"}).where(eq(schema.hermesRunContexts.runId,run.id));
    await freshConversation(alice,{conversationId:home.id,bot:b,app},newId());
  });

  it("/new does not adopt existing IDs or other users' conversations; side-chat /new stays separate", async () => {
    const { db,schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const { openSideChat } = await import("@/lib/chat/side");
    const { freshConversation } = await import("@/lib/chat/fresh");
    const { newId } = await import("@/lib/ids");
    const b=await newBot();const home=await openBotHome(alice,b.id);
    const [app]=await db.select().from(schema.aiApps).where(eq(schema.aiApps.id,appId));
    const side=await openSideChat(alice,b.id,newId());
    await expect(freshConversation(alice,{conversationId:home.id,bot:b,app},side.id)).rejects.toMatchObject({status:409});
    expect((await openBotHome(alice,b.id)).id).toBe(home.id);
    await expect(freshConversation(bob,{conversationId:home.id,bot:b,app},newId())).rejects.toMatchObject({status:404});
    const next=await freshConversation(alice,{conversationId:side.id,bot:b,app},newId());
    expect(next.isBotHome).toBe(false);expect((await openBotHome(alice,b.id)).id).toBe(home.id);
    expect(new Set((await Promise.all(Array.from({length:12},()=>openSideChat(alice,b.id,next.id)))).map(r=>r.id)).size).toBe(1);
    await expect(openSideChat(bob,b.id,next.id)).rejects.toMatchObject({status:409});
  });

  it("run admission and home rollover serialize: exactly one wins and a rejected send leaves no message", async () => {
    const { db, schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const { freshConversation } = await import("@/lib/chat/fresh");
    const { startRun } = await import("@/lib/runs/store");
    const { newId } = await import("@/lib/ids");
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    for (let n = 0; n < 12; n++) {
      const bot = await newBot();
      const home = await openBotHome(alice, bot.id);
      const message = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "Concurrent turn" }] };
      const [admission, rollover] = await Promise.allSettled([
        startRun({ principal: alice, conversation: home, bot, app, userMessage: message, parentId: null }),
        freshConversation(alice, { conversationId: home.id, bot, app }, newId()),
      ]);
      expect([admission, rollover].filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = [admission, rollover].find((r) => r.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ status: 409 });
      expect(await db.select().from(schema.messages).where(eq(schema.messages.id, message.id))).toHaveLength(admission.status === "fulfilled" ? 1 : 0);
      if (admission.status === "fulfilled") {
        expect((await openBotHome(alice, bot.id)).id).toBe(home.id);
        await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, admission.value.id));
      } else {
        expect((await openBotHome(alice, bot.id)).id).not.toBe(home.id);
        await expect(startRun({ principal: alice, conversation: home, bot, app, userMessage: message, parentId: null })).rejects.toMatchObject({ status: 409 });
      }
    }
  });

  it("legacy approvals and a concurrently deleted source cannot be silently rolled over", async () => {
    const { db, schema } = await import("@/db");
    const { openBotHome } = await import("@/lib/chat/home");
    const { freshConversation } = await import("@/lib/chat/fresh");
    const { newId } = await import("@/lib/ids");
    const bot = await newBot();
    const home = await openBotHome(alice, bot.id);
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await db.insert(schema.messages).values({ id: newId(), conversationId: home.id, role: "assistant", parts: [{ type: "tool-fetch_url", state: "approval-requested", approval: { id: "legacy-approval" } }] });
    await expect(freshConversation(alice, { conversationId: home.id, bot, app }, newId())).rejects.toMatchObject({ status: 409 });
    expect((await openBotHome(alice, bot.id)).id).toBe(home.id);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, home.id));
    const next = newId();
    await expect(freshConversation(alice, { conversationId: home.id, bot, app, requireSource: true }, next)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.id, next))).toHaveLength(0);
  });

  it("local /new works for non-Hermes bot homes and rejects unsupported native commands", async () => {
    const {openBotHome}=await import("@/lib/chat/home");
    const {executeHermesCommand}=await import("@/lib/chat/hermes-command-service");
    const {newId}=await import("@/lib/ids");
    const b=await newBot();const home=await openBotHome(alice,b.id);const next=newId();
    const result=await executeHermesCommand(alice,{conversationId:home.id,text:"/new",newConversationId:next});
    expect(result).toMatchObject({title:"Fresh home chat",navigateTo:`/c/${next}`});
    expect((await openBotHome(alice,b.id)).id).toBe(next);
    await expect(executeHermesCommand(alice,{conversationId:next,text:"/new with args",newConversationId:newId()})).rejects.toMatchObject({status:400});
    await expect(executeHermesCommand(alice,{conversationId:next,text:"/model anything"})).rejects.toMatchObject({status:400});
  });

  it("activity and outputs expose only this user's work with this bot and never turn uploads or foreign files into outputs", async () => {
    const {db,schema}=await import("@/db");
    const {loadBotActivity}=await import("@/lib/chat/activity");
    const {openBotHome}=await import("@/lib/chat/home");
    const {newId}=await import("@/lib/ids");
    const b=await newBot();const home=await openBotHome(alice,b.id);const other=await openBotHome(bob,b.id);
    const [ownFile,foreignFile]=await db.insert(schema.attachments).values([
      {userId:alice.user.id,filename:"Owned output.txt",mediaType:"text/plain",size:3,storageKey:newId()},
      {userId:bob.user.id,filename:"Private Bob output.txt",mediaType:"text/plain",size:3,storageKey:newId()},
    ]).returning();
    for(let n=0;n<15;n++){
      const q=newId(),answer=newId();
      await db.insert(schema.messages).values([{id:q,conversationId:home.id,role:"user",parts:[{type:"text",text:`Task ${n}`}],searchText:`Task ${n}`},
        {id:answer,conversationId:home.id,role:"assistant",parts:[{type:"text",text:`Result ${n}`},{type:"file",url:`/api/files/${ownFile.id}`},{type:"file",url:`/api/files/${foreignFile.id}`}]}]);
      await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,messageId:answer,parentMessageId:q,appId,botId:b.id,status:n===14?"waiting":"succeeded",updatedAt:n===14?new Date("2025-01-01"):new Date()});
    }
    await db.insert(schema.inboxItems).values({userId:alice.user.id,kind:"approval",title:"Needs review",conversationId:home.id});
    const foreignAnswer=newId();
    await db.insert(schema.messages).values({id:foreignAnswer,conversationId:other.id,role:"assistant",parts:[{type:"text",text:"Private Bob result"}]});
    await db.insert(schema.agentRuns).values({userId:bob.user.id,conversationId:other.id,messageId:foreignAnswer,botId:b.id,appId,status:"succeeded",background:true});
    // Text-only replies beyond the previous 20-message window must not hide the real older file.
    for (let n = 0; n < 25; n++) await db.insert(schema.messages).values({id:newId(),conversationId:home.id,role:"assistant",parts:[{type:"text",text:"Ordinary saved reply"}]});
    const result=await loadBotActivity(alice,b.id);
    expect(result.activity).toHaveLength(1);expect(result.outputs).toHaveLength(1);
    expect(result.state).toEqual({working:false,awaitingApproval:true});
    expect(result.activity.find(r=>r.status==="waiting")?.unread).toBe(true);
    expect(result.activity.filter(r=>r.status!=="waiting").every(r=>!r.unread)).toBe(true);
    expect(result.outputs.some(o=>o.title==="Owned output.txt")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Private Bob|Result 14/);
    expect(result.outputs.every(o=>o.kind==="file")).toBe(true);
    const bobResult=await loadBotActivity({...bob,isAdmin:true},b.id);
    expect(bobResult.activity).toHaveLength(1);expect(bobResult.outputs).toHaveLength(0);
    expect(JSON.stringify(bobResult)).not.toMatch(/Owned output|Result 13|Task 14/);
    await db.insert(schema.messages).values({id:newId(),conversationId:home.id,role:"user",parts:[{type:"file",url:`/api/files/${ownFile.id}`}]});
    expect((await loadBotActivity(alice,b.id)).outputs).toHaveLength(0); // echoed user input isn't an output
    await db.delete(schema.attachments).where(inArray(schema.attachments.id,[ownFile.id,foreignFile.id]));
  });

  it("activity uses typed work/status rules, keeps latest failures, and counts open work beyond its display limit", async () => {
    const {db,schema}=await import("@/db");
    const {loadBotActivity}=await import("@/lib/chat/activity");
    const {openBotHome}=await import("@/lib/chat/home");
    const {newId}=await import("@/lib/ids");
    const b=await newBot();const home=await openBotHome(alice,b.id);
    const [failedChat]=await db.insert(schema.conversations).values({userId:alice.user.id,botId:b.id,title:"Needs retry"}).returning();
    const old=new Date("2025-01-01");
    const [supersededFailure]=await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"failed",createdAt:old}).returning();
    const [plain,task,failure,cancelled]=await db.insert(schema.agentRuns).values([
      {userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"succeeded" as const},
      {userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"succeeded" as const,background:true},
      {userId:alice.user.id,conversationId:failedChat.id,botId:b.id,appId,messageId:newId(),status:"interrupted" as const},
      {userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"cancelled" as const},
    ]).returning();
    const quiet=await loadBotActivity(alice,b.id);
    expect(new Set(quiet.activity.map(r=>r.id))).toEqual(new Set([task.id,failure.id]));
    expect(quiet.activity.map(r=>r.id)).not.toEqual(expect.arrayContaining([plain.id,cancelled.id,supersededFailure.id]));
    expect(quiet.activity.find(r=>r.id===task.id)?.kind).toBe("background");
    const [routine]=await db.insert(schema.routines).values({ownerId:alice.user.id,botId:b.id,name:"Daily audit",prompt:"Check evidence",triggerType:"webhook",enabled:false}).returning();
    const [routineRun]=await db.insert(schema.routineRuns).values({routineId:routine.id,conversationId:home.id,trigger:"manual",status:"succeeded"}).returning();
    const [completedRoutine]=await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"succeeded",routineRunId:routineRun.id}).returning();
    expect((await loadBotActivity(alice,b.id)).activity.find(r=>r.id===completedRoutine.id)).toMatchObject({kind:"routine",title:"Daily audit"});
    for(let n=0;n<12;n++) await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"waiting"});
    await db.insert(schema.agentRuns).values({userId:alice.user.id,conversationId:home.id,botId:b.id,appId,messageId:newId(),status:"running"});
    const busy=await loadBotActivity(alice,b.id);
    expect(busy.activity).toHaveLength(10);
    expect(busy.activity.every(r=>r.status==="waiting")).toBe(true);
    expect(busy.state).toEqual({working:true,awaitingApproval:true});
    expect((await loadBotActivity(bob,b.id)).state).toEqual({working:false,awaitingApproval:false});
  });

});

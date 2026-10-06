import { readFileSync, readdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentCtx } from "@/lib/agent/types";
import type { Principal } from "@/lib/auth/groups";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, enqueue: vi.fn(async () => "fixture-job"), exec: vi.fn(), write: vi.fn(), model: vi.fn(), lock: vi.fn(async (tx: unknown, userId: string) => { void tx; void userId; }) }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite"); const { drizzle } = await import("drizzle-orm/pglite"); const schema = await import("@/db/schema");
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/runs/lock", () => ({ lockUserRuns: fixture.lock })); // Embedded Postgres serializes transactions; no advisory locks.
vi.mock("@/lib/runs/host", () => ({ runHost: () => ({ instanceId:"fixture-worker", shuttingDown:false, track:()=>()=>{} }) }));
vi.mock("@/lib/jobs", () => ({ enqueueRun:fixture.enqueue, enqueue:async()=>null, scheduleMemoryExtraction:async()=>{}, getBoss:async()=>{throw new Error("No fixture queue transport");} }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), resolveModel: fixture.model, utilityApp:async()=>undefined, generateTitle:async()=>"Fixture" }));
vi.mock("@/lib/sandbox/client", async original => ({ ...await original<typeof import("@/lib/sandbox/client")>(), sandboxd:()=>({exec:fixture.exec,writeFile:fixture.write,kill:async()=>({killed:false})}) }));
import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { getSetting, setSetting } from "@/lib/settings";
import { newUsageScope } from "@/lib/llm";
import { upsertMessage } from "@/lib/chat/store";
import { startAsyncDelegation, suspendForTasks, reconcileAsyncTasks } from "@/lib/delegation/async";
import { answerTaskApproval, pendingTaskApprovals } from "@/lib/delegation/approvals";
import { getRun } from "@/lib/runs/state";
import { executeRun } from "@/lib/runs/execute";
import { stopRuns } from "@/lib/runs/store";
import { buildToolset } from "@/lib/agent/toolset";
let owner: Principal; let other: Principal;
const usage = {inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
const finish = (reason:"stop"|"tool-calls"):LanguageModelV4StreamPart => ({type:"finish",finishReason:{unified:reason,raw:reason},usage});
const call = (id:string, command="printf fixture"):LanguageModelV4StreamPart => ({type:"tool-call",toolCallId:id,toolName:"workspace_bash",input:JSON.stringify({command})});
const response = ():LanguageModelV4StreamPart[] => [{type:"text-start",id:"text"},{type:"text-delta",id:"text",delta:"Fixture done"},{type:"text-end",id:"text"},finish("stop")];
function scripted(parts:LanguageModelV4StreamPart[]=[call("command"),finish("tool-calls")]) {
  let calls=0;
  const model = new MockLanguageModelV4({ doStream:async()=>({stream:convertArrayToReadableStream(calls++===0?parts:response())}) });
  fixture.model.mockResolvedValue({model,capabilities:{instructionStyle:"legacy",embeddings:false,responses:false},billing:{source:"org"},replayKey:null});
  return model;
}
beforeAll(async()=>{
  await fixture.client!.waitReady;
  for(const file of readdirSync("src/db/migrations").filter(f=>f.endsWith(".sql")).sort()) await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`,"utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;","").replace(/\bvector\b/g,"real[]"));
},45_000);
beforeEach(async()=>{
  vi.stubEnv("AUTH_SECRET","synthetic-fixture-secret-never-a-provider-credential");
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values([{id:"owner",upn:"owner@test.invalid",name:"Owner",authSource:"ldap"},{id:"other",upn:"other@test.invalid",name:"Other",authSource:"ldap"}]);
  owner=(await loadPrincipal("owner"))!; other=(await loadPrincipal("other"))!;
  await db.insert(schema.aiApps).values({id:"model",name:"Fixture model",provider:"openai",model:"fixture",supportsTools:true,isPublic:true});
  await db.insert(schema.bots).values([{id:"queen",ownerId:"owner",appId:"model",name:"Queen"},{id:"bot",ownerId:"owner",appId:"model",name:"Worker"}]);
  await db.insert(schema.botDelegates).values({botId:"queen",delegateBotId:"bot"});
  await db.insert(schema.botTools).values({botId:"bot",toolKey:"workspace",approval:"auto"});
  await setSetting("sandbox",{enabled:true,access:"everyone",allowedGroupIds:[],allowedUpns:[],allowRunc:false,commandTimeoutSec:120,outputKb:32,deleteAfterDays:30});
  await db.insert(schema.conversations).values([{id:"origin",userId:"owner",botId:"queen",title:"Fixture origin"},{id:"unrelated",userId:"owner",botId:"queen"},{id:"foreign",userId:"other",botId:"queen"}]);
  fixture.write.mockReset();fixture.write.mockImplementation(async (_ref: string, input: {contentB64:string}) => ({created:true,bytes:Buffer.from(input.contentB64,"base64").length}));fixture.exec.mockReset();fixture.exec.mockResolvedValue({t:"exit",code:0,reason:"exited",ms:1,dropped:0});fixture.enqueue.mockClear();fixture.lock.mockReset();fixture.lock.mockResolvedValue(undefined);scripted();
});
afterAll(async()=>{await fixture.client!.close();vi.unstubAllEnvs();});
async function paused(parts?:LanguageModelV4StreamPart[]) {
  const [app]=await db.select().from(schema.aiApps).where(eq(schema.aiApps.id,"model")); const [bot]=await db.select().from(schema.bots).where(eq(schema.bots.id,"queen"));
  const [parent]=await db.insert(schema.agentRuns).values({id:"parent",userId:"owner",conversationId:"origin",messageId:"parent-message",botId:"queen",appId:"model",status:"running",holder:"fixture-worker"}).returning();
  const native={deadlineAt:Date.now()+60_000,sessionVersion:0,stepsUsed:1,maxSteps:20,taskIds:[] as string[]};
  const ctx:AgentCtx={principal:owner,bot,app,conversationId:"origin",depth:0,background:false,toolSettings:await getSetting("tools"),usage:newUsageScope({messageId:parent.messageId,runId:parent.id}),execution:{holder:"fixture-worker",deadlineAt:native.deadlineAt,segment:0},awaitTask:id=>native.taskIds.push(id)};
  const receipt=await startAsyncDelegation(ctx,"bot","Fixture workspace task","assignment");
  await upsertMessage("origin",{id:parent.messageId,role:"assistant",parts:[{type:"tool-ask_worker",toolCallId:"assignment",state:"output-available",input:{task:"Fixture workspace task"},output:receipt} as never]},null,{});
  await suspendForTasks(parent,"fixture-worker",native,[]);
  const [task]=await db.select().from(schema.delegatedTasks).where(eq(schema.delegatedTasks.id,receipt.taskId));
  scripted(parts);await executeRun(task.childRunId!);
  expect((await getRun(task.childRunId!))?.status).toBe("waiting");expect(fixture.exec).not.toHaveBeenCalled();
  return {task,requests:await pendingTaskApprovals(owner,"origin")};
}
describe("durable native workspace approvals with embedded PostgreSQL and real executor/SDK",()=>{
  it("shows the same durable request to the owner in coordinator and task chats, then dispatches once",async()=>{
    const {task,requests}=await paused();expect(requests).toHaveLength(1);
    expect(await pendingTaskApprovals(owner,task.childConversationId!)).toEqual(requests);
    const request=requests[0];const answer={runId:request.runId,approvalId:request.part.approval!.id,approved:true};
    await answerTaskApproval(owner,"origin",answer);await answerTaskApproval(owner,task.childConversationId!,answer);
    expect((await getRun(request.runId))?.segment).toBe(1);
    scripted(response());await executeRun(request.runId);await executeRun(request.runId);
    expect(fixture.exec).toHaveBeenCalledTimes(1);expect((await getRun(request.runId))?.status).toBe("succeeded");
  });
  it("denial resumes the child without executing the command",async()=>{
    const {requests}=await paused();const r=requests[0];await answerTaskApproval(owner,"origin",{runId:r.runId,approvalId:r.part.approval!.id,approved:false});scripted(response());await executeRun(r.runId);
    expect(fixture.exec).not.toHaveBeenCalled();expect((await getRun(r.runId))?.status).toBe("succeeded");
  });
  it("rejects foreign owners, unrelated chats and guessed request IDs",async()=>{
    const {requests}=await paused();const r=requests[0];const answer={runId:r.runId,approvalId:r.part.approval!.id,approved:true};
    await expect(pendingTaskApprovals(other,"origin")).rejects.toMatchObject({status:404});
    await expect(answerTaskApproval(other,"foreign",answer)).rejects.toMatchObject({status:404});
    await expect(answerTaskApproval({...other,isAdmin:true},"origin",answer)).rejects.toMatchObject({status:404});
    await expect(answerTaskApproval(owner,"unrelated",answer)).rejects.toMatchObject({status:404});
    await expect(answerTaskApproval(owner,"origin",{...answer,approvalId:"guessed"})).rejects.toMatchObject({status:404});
    expect(fixture.exec).not.toHaveBeenCalled();
  });
  it("keeps partial approvals waiting and prevents conflicting replays",async()=>{
    const {requests}=await paused([call("a"),call("b"),finish("tool-calls")]);expect(requests).toHaveLength(2);
    const [a,b]=requests;await answerTaskApproval(owner,"origin",{runId:a.runId,approvalId:a.part.approval!.id,approved:true});expect((await getRun(a.runId))?.status).toBe("waiting");
    await expect(answerTaskApproval(owner,"origin",{runId:a.runId,approvalId:a.part.approval!.id,approved:false})).rejects.toMatchObject({status:409});
    await answerTaskApproval(owner,"origin",{runId:b.runId,approvalId:b.part.approval!.id,approved:false});scripted(response());await executeRun(a.runId);expect(fixture.exec).toHaveBeenCalledTimes(1);
  });
  it("preserves waiting requests across recovery without executing and expires them safely",async()=>{
    const {task,requests}=await paused();await reconcileAsyncTasks();expect(await pendingTaskApprovals(owner,"origin")).toEqual(requests);expect(fixture.exec).not.toHaveBeenCalled();
    await db.update(schema.delegatedTasks).set({deadlineAt:new Date(0)}).where(eq(schema.delegatedTasks.id,task.id));
    await expect(answerTaskApproval(owner,"origin",{runId:requests[0].runId,approvalId:requests[0].part.approval!.id,approved:true})).rejects.toMatchObject({status:409});
    await reconcileAsyncTasks();expect((await getRun(task.childRunId!))?.status).toBe("failed");expect(await pendingTaskApprovals(owner,"origin")).toEqual([]);
  });
  it.each(["origin","task"])("cancels paused children when Stop is pressed in %s",async(where)=>{
    const {task}=await paused();await stopRuns(owner,where==="origin"?"origin":task.childConversationId!);await reconcileAsyncTasks();expect((await getRun(task.childRunId!))?.status).toBe("cancelled");expect(fixture.exec).not.toHaveBeenCalled();
  });
  it("revokes pending requests when the delegation edge or owner session changes",async()=>{
    const {task,requests}=await paused();await db.delete(schema.botDelegates).where(and(eq(schema.botDelegates.botId,"queen"),eq(schema.botDelegates.delegateBotId,"bot")));
    await expect(answerTaskApproval(owner,"origin",{runId:requests[0].runId,approvalId:requests[0].part.approval!.id,approved:true})).rejects.toMatchObject({status:403});await reconcileAsyncTasks();expect((await getRun(task.childRunId!))?.status).toBe("failed");expect(fixture.exec).not.toHaveBeenCalled();
  });
  it("uses durable scheduling even when a native workspace specialist is requested in sync mode",async()=>{
    const [bot]=await db.select().from(schema.bots).where(eq(schema.bots.id,"queen"));const [app]=await db.select().from(schema.aiApps).where(eq(schema.aiApps.id,"model"));
    const ctx:AgentCtx={principal:owner,bot,app,conversationId:"origin",depth:0,background:false,toolSettings:await getSetting("tools"),awaitTask:()=>{}};
    const tools=await buildToolset(ctx);expect(tools.entries.find(e=>e.name.startsWith("ask_"))?.tool.description).toContain("Both mode values schedule independent work");await tools.close();
  });
  it("serializes simultaneous answers from coordinator and task views into one queued segment",async()=>{
    const {task,requests}=await paused();const r=requests[0];const answer={runId:r.runId,approvalId:r.part.approval!.id,approved:true};fixture.enqueue.mockClear();
    await Promise.all([answerTaskApproval(owner,"origin",answer),answerTaskApproval(owner,task.childConversationId!,answer)]);
    expect((await getRun(r.runId))?.segment).toBe(1);expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    scripted(response());await executeRun(r.runId);expect(fixture.exec).toHaveBeenCalledTimes(1);
  });
  it("blocks stale owner sessions and changed tool configuration before dispatch",async()=>{
    const {requests}=await paused();const r=requests[0];const answer={runId:r.runId,approvalId:r.part.approval!.id,approved:true};
    await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,"owner"));
    await expect(answerTaskApproval(owner,"origin",answer)).rejects.toMatchObject({status:403});
    await db.update(schema.users).set({sessionVersion:0}).where(eq(schema.users.id,"owner"));
    await answerTaskApproval(owner,"origin",answer);
    await db.update(schema.botTools).set({approval:"ask"}).where(eq(schema.botTools.botId,"bot"));
    scripted(response());await executeRun(r.runId);expect(fixture.exec).not.toHaveBeenCalled();expect((await getRun(r.runId))?.status).toBe("failed");
  });
  it("cancels when a running child pauses after the initial Stop snapshot",async()=>{
    const {task}=await paused();await db.update(schema.agentRuns).set({status:"running",holder:"fixture-worker"}).where(eq(schema.agentRuns.id,task.childRunId!));
    fixture.lock.mockImplementationOnce(async (value: unknown) => { const tx=value as typeof db; await tx.update(schema.agentRuns).set({status:"waiting",holder:null}).where(eq(schema.agentRuns.id,task.childRunId!)); });
    const result=await stopRuns(owner,task.childConversationId!);expect(result.cancelled).toBe(1);expect((await getRun(task.childRunId!))?.status).toBe("cancelled");expect(fixture.exec).not.toHaveBeenCalled();
  });
  it("recovers an approved queued segment after lost queue delivery without replaying a command",async()=>{
    const {requests}=await paused();const r=requests[0];fixture.enqueue.mockRejectedValueOnce(new Error("Synthetic queue unavailable"));
    await answerTaskApproval(owner,"origin",{runId:r.runId,approvalId:r.part.approval!.id,approved:true});expect((await getRun(r.runId))?.status).toBe("queued");
    scripted(response());await executeRun(r.runId);await executeRun(r.runId);expect(fixture.exec).toHaveBeenCalledTimes(1);
  });
  it("rotates healthy recovery rows so later expired requests cannot starve",async()=>{
    const {task}=await paused();const original=(await getRun(task.childRunId!))!;
    // Simulate a global batch across many owners without invoking production admission or tools.
    const runs=Array.from({length:101},(_,i)=>({...original,id:`batch-run-${i}`,messageId:`batch-message-${i}`,conversationId:`batch-chat-${i}`,updatedAt:new Date(1000+i)}));
    await db.insert(schema.conversations).values(runs.map(run=>({id:run.conversationId,userId:"owner",botId:"bot",source:"delegation" as const})));
    await db.insert(schema.agentRuns).values(runs);
    await db.insert(schema.delegatedTasks).values(runs.map((run,i)=>({...task,id:`batch-task-${i}`,rootTaskId:`batch-task-${i}`,childRunId:run.id,childConversationId:run.conversationId,originToolCallId:`batch-call-${i}`,deadlineAt:i===100?new Date(0):new Date(Date.now()+60_000)})));
    await reconcileAsyncTasks();expect((await getRun("batch-run-100"))?.status).toBe("waiting");
    await reconcileAsyncTasks();expect((await getRun("batch-run-100"))?.status).toBe("failed");expect(fixture.exec).not.toHaveBeenCalled();
  },30_000); // Two 100-row embedded Postgres batches exceed the default timeout in CI Docker.

  it("relays and executes the approved file write with its original bytes once",async()=>{
    const content='<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>';
    const {requests}=await paused([{type:"tool-call",toolCallId:"write",toolName:"workspace_write",input:JSON.stringify({path:"drawing.svg",content})},finish("tool-calls")]);
    expect(fixture.write).not.toHaveBeenCalled();const r=requests[0];
    await answerTaskApproval(owner,"origin",{runId:r.runId,approvalId:r.part.approval!.id,approved:true});scripted(response());await executeRun(r.runId);await executeRun(r.runId);
    expect(fixture.write).toHaveBeenCalledTimes(1);expect(Buffer.from(fixture.write.mock.calls[0][1].contentB64,"base64").toString()).toBe(content);expect(fixture.exec).not.toHaveBeenCalled();
  });

});

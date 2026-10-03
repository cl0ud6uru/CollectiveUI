import { expect, test } from "@playwright/test";
import { login, openBot, send } from "./helpers";
import { Pool } from "pg";
import { storage } from "../../src/lib/files/storage";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let botId: string;
let botName: string;
let priorId: string;
const uploadedFiles: string[] = [];

test.beforeAll(async () => {
  const owner = await pool.query("SELECT id FROM users WHERE upn='alice@corp.local'");
  const app = await pool.query("SELECT id FROM ai_apps WHERE name='Mock GPT'");
  botId = `e2eHome${Date.now()}`;
  botName = "Project Partner";
  priorId = `e2ePrior${Date.now()}`;
  await pool.query("INSERT INTO bots (id,owner_id,name,app_id,visibility,description) VALUES ($1,$2,$3,$4,'org','An ongoing home with focused side chats')", [botId, owner.rows[0].id, botName, app.rows[0].id]);
  await pool.query("INSERT INTO bot_tools (bot_id,tool_key,approval) VALUES ($1,'fetch_url','ask')", [botId]);
  await pool.query("INSERT INTO conversations (id,user_id,bot_id,title,current_leaf_id) VALUES ($1,$2,$3,'Existing focused work',$4)", [priorId, owner.rows[0].id, botId, `msg${priorId}`]);
  await pool.query("INSERT INTO messages (id,conversation_id,role,parts,search_text) VALUES ($1,$2,'user',$3,'Original history retained')", [`msg${priorId}`,priorId,JSON.stringify([{type:'text',text:'Original history retained'}])]);
});
test.afterAll(async () => {
  for (const id of uploadedFiles) {
    const file = await pool.query("DELETE FROM attachments WHERE id=$1 RETURNING storage_key", [id]);
    if (file.rows[0]) await storage().delete(file.rows[0].storage_key);
  }
  await pool.query("DELETE FROM conversations WHERE bot_id=$1", [botId]);
  await pool.query("DELETE FROM bots WHERE id=$1", [botId]);
  await pool.end();
});

// Run in order: preserve messages to verify resume/navigation through the same saved IDs.
test.describe.configure({ mode: "serial" });
let homeUrl: string;
let sideUrl: string;

test("bot selection, picker, repeated clicks and two tabs converge on the same home", async ({ page, context }) => {
  await login(page,"alice");
  // The default picker is also a bot selection entry point.
  await page.locator("header button").filter({has:page.locator("svg.lucide-chevron-down")}).click();
  await page.getByRole("menuitem",{name:botName}).click();
  await page.waitForURL(/\/c\//);
  homeUrl=page.url();
  await expect(page.locator("header").getByRole("heading", { name: botName, exact: true })).toBeVisible();
  await expect(page.getByText("Original history retained",{exact:true})).toBeHidden();
  await send(page,"Remember this home greeting");
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
  // Assert immediately after first creation: a reload used to conceal the phantom New chat row.
  await page.mouse.move(700,700);
  const botLink = page.locator(`nav a[href="/?bot=${botId}"]`);
  await expect(botLink).toHaveAttribute('aria-current','page');
  await expect(botLink.locator('..')).toHaveClass(/(?:^|\s)bg-hover(?:\s|$)/);
  await expect(page.locator(`nav a[href="/c/${homeUrl.split('/c/')[1]}"]`)).toHaveCount(0);
  await expect(page.locator('nav a[aria-current="page"]')).toHaveCount(1);
  const second=await context.newPage();
  await Promise.all([page.goto(`/?bot=${botId}`),second.goto(`/?bot=${botId}`)]);
  await expect(page).toHaveURL(homeUrl);
  await expect(second).toHaveURL(homeUrl);
  for(let n=0;n<3;n++) {
    await page.goto("/bots");
    await page.getByRole("link",{name:`Chat with ${botName}`,exact:true}).click({clickCount:2});
    await expect(page).toHaveURL(homeUrl);
  }
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
  expect((await pool.query("SELECT id FROM conversations WHERE bot_id=$1 AND is_bot_home",[botId])).rows).toHaveLength(1);
  await second.close();
});

test("side chat is separate; home, history, reload and back/forward preserve saved transcripts", async ({ page }) => {
  await login(page,"alice");
  await openBot(page,botName);
  await page.getByRole("button",{name:"Start side chat",exact:true}).click();
  await expect(page).not.toHaveURL(homeUrl);
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeHidden();
  await send(page,"Focused side topic");
  await expect(page.getByText('You said: "Focused side topic"',{exact:true})).toBeVisible();
  sideUrl=page.url();
  expect(sideUrl).not.toBe(homeUrl);
  const sideLink = page.locator(`nav a[href="/c/${sideUrl.split('/c/')[1]}"]`);
  await expect(sideLink).toHaveAttribute('aria-current','page');
  await expect(page.locator(`nav a[href="/?bot=${botId}"]`)).not.toHaveAttribute('aria-current','page');
  await page.getByRole("link",{name:"Open home chat",exact:true}).click();
  await expect(page).toHaveURL(homeUrl);
  await page.goBack();
  await expect(page).toHaveURL(sideUrl);
  await expect(page.getByText('You said: "Focused side topic"',{exact:true})).toBeVisible();
  await expect(sideLink).toHaveAttribute('aria-current','page');
  await page.goForward();
  await expect(page).toHaveURL(homeUrl);
  await expect(page.locator(`nav a[href="/?bot=${botId}"]`)).toHaveAttribute('aria-current','page');
  await expect(sideLink).not.toHaveAttribute('aria-current','page');
  await page.reload();
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Bot chat history"}).click();
  await page.getByRole("menuitem",{name:"All chats and archives"}).click();
  // The same chat is also listed in the sidebar's history; pick the one on the chat history page.
  await page.getByRole("main").getByRole("link",{name:"Existing focused work"}).click();
  await expect(page.getByText("Original history retained",{exact:true})).toBeVisible();
  await page.goto(homeUrl);
});

test("mobile navigation closes the sidebar and makes home/side/history usable without overflow", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await login(page,"alice");
  await page.goto(homeUrl);
  await page.getByRole("button",{name:"Open sidebar"}).click();
  await page.mouse.move(380,800);
  await expect(page.locator(`nav a[href="/?bot=${botId}"]:visible`)).toHaveAttribute('aria-current','page');
  await expect(page.locator(`nav a[href="/c/${homeUrl.split('/c/')[1]}"]:visible`)).toHaveCount(0);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/chat/${homeUrl.split('/c/')[1]}`)),
    page.locator(`nav a[href="/?bot=${botId}"]:visible`).click(),
  ]);
  await expect(page.getByRole("button",{name:"Close sidebar"})).toBeHidden();
  await expect(page.getByRole("button",{name:"Start side chat",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Bot chat history"}).click();
  await expect(page.getByRole("menuitem",{name:"All chats and archives"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("other users cannot see the owner's home or side chat and get their own bot home",async({page,browser})=>{
  const ctx=await browser.newContext();const bob=await ctx.newPage();
  await login(bob,"bob");
  for(const url of [homeUrl,sideUrl]){
    const snapshot=await bob.request.get(`/api/chat/${url.split('/c/')[1]}`);
    expect(snapshot.status()).toBe(404);
    const r=await bob.request.post('/api/chat',{data:{conversationId:url.split('/c/')[1],regenerate:true,parentId:'bogus'}});
    expect(r.status()).toBe(404);
    await bob.goto(url);
    await expect(bob.getByText('This page could not be found.')).toBeVisible();
    await expect(bob.getByText('You said: "Remember this home greeting"',{exact:true})).toBeHidden();
  }
  await openBot(bob,botName);expect(bob.url()).not.toBe(homeUrl);
  await bob.goto(`/bots/${botId}/chats`);
  await expect(bob.getByRole('link',{name:'Existing focused work'})).toBeHidden();
  await ctx.close();
  await login(page,"alice");
  await pool.query("UPDATE bots SET enabled=false WHERE id=$1",[botId]);
  await page.goto(homeUrl);
  await expect(page.getByRole('status').filter({hasText:'unavailable'})).toBeVisible();
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Message',{exact:true})).toBeDisabled();
  await expect(page.locator(`nav a[href="/c/${homeUrl.split('/c/')[1]}"]`)).toHaveAttribute('aria-current','page');
  await expect(page.locator(`nav a[href="/?bot=${botId}"]`)).toHaveCount(0);
  const refused=await page.request.post('/api/chat',{data:{conversationId:homeUrl.split('/c/')[1],message:{id:'DisabledNewMessage',role:'user',parts:[{type:'text',text:'no'}]}}});
  expect(refused.status()).toBe(403);
  await page.goto(`/?bot=${botId}`);await expect(page.getByText('Bot unavailable',{exact:true})).toBeVisible();
  await pool.query("UPDATE bots SET enabled=true WHERE id=$1",[botId]);
});

test("archive preserves transcript and retired chat in archives; next click makes a fresh home",async({page})=>{
  await login(page,"alice");await page.goto(homeUrl);
  await page.getByRole('button',{name:'Bot chat history'}).click();
  await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await page.waitForURL('/');
  await openBot(page,botName);expect(page.url()).not.toBe(homeUrl);
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeHidden();
  await page.goto(`/bots/${botId}/chats`);
  const archived=page.locator(`a[href="/c/${homeUrl.split('/c/')[1]}"]`);
  await expect(archived.getByText('Archived')).toBeVisible();await archived.click();
  await expect(page.getByText('You said: "Remember this home greeting"',{exact:true})).toBeVisible();
});

test("/new rolls the home into Today, preserves memory and replays one rollover on repeated requests",async({page})=>{
  await login(page,"alice");await openBot(page,botName);
  const source=page.url();const sourceId=source.split('/c/')[1];
  await send(page,"Work to keep in dated history");
  await expect(page.getByText('You said: "Work to keep in dated history"',{exact:true})).toBeVisible();
  await expect.poll(async()=> (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",[sourceId])).rows[0]?.status).toBe('succeeded');
  await pool.query("UPDATE conversations SET updated_at='2025-01-01' WHERE id=$1",[sourceId]);
  const memoryId=`e2eMemory${Date.now()}`;
  await pool.query("INSERT INTO memories (id,user_id,bot_id,content) SELECT $1,user_id,bot_id,'Memory survives rollover' FROM conversations WHERE id=$2",[memoryId,sourceId]);
  await page.getByLabel('Message',{exact:true}).fill('/new');await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(source);
  const successor=page.url();
  await expect(page.locator("header").getByRole("heading", { name: botName, exact: true })).toBeVisible();
  await expect(page.getByText('You said: "Work to keep in dated history"',{exact:true})).toBeHidden();
  await expect(page.locator(`nav a[href="/c/${sourceId}"]`)).toBeVisible();
  await expect(page.locator(`nav a[href="/c/${successor.split('/c/')[1]}"]`)).toHaveCount(0);
  await expect(page.locator(`nav a[href="/?bot=${botId}"]`)).toHaveAttribute('aria-current','page');
  const retries=await Promise.all(Array.from({length:8},(_,n)=>page.request.post('/api/chat/commands',{data:{conversationId:sourceId,text:'/new',newConversationId:`e2eRetry${Date.now()}${n}`}})));
  for(const response of retries){expect(response.status()).toBe(200);expect((await response.json()).navigateTo).toBe(`/c/${successor.split('/c/')[1]}`);}
  const saved=(await pool.query("SELECT is_bot_home,archived,updated_at FROM conversations WHERE id=$1",[sourceId])).rows[0];
  expect(saved.is_bot_home).toBe(false);expect(saved.archived).toBe(false);expect(+new Date(saved.updated_at)).toBeGreaterThan(Date.now()-60_000);
  expect((await pool.query("SELECT content FROM memories WHERE id=$1",[memoryId])).rows[0].content).toBe('Memory survives rollover');
  await page.goto(source);
  await expect(page.getByText('You said: "Work to keep in dated history"',{exact:true})).toBeVisible();
  await openBot(page,botName);await expect(page).toHaveURL(successor);
  await pool.query('DELETE FROM memories WHERE id=$1',[memoryId]);
});

test("home rollover refuses a live run and a pending approval, and returning to the home resumes both", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, botName);
  const home = page.url();
  const id = home.split('/c/')[1];
  const prompt = `[slow] ${Array.from({length:25}, (_, n) => `word${n}`).join(' ')} homeResumeDone`;
  await send(page, prompt);
  await expect(page.getByLabel('Stop generating')).toBeVisible();
  const refused = await page.request.post('/api/chat/commands', {data:{conversationId:id,text:'/new',newConversationId:`e2eBlocked${Date.now()}`}});
  expect(refused.status()).toBe(409);
  await page.goto('/bots');
  await page.goBack();
  await expect(page).toHaveURL(home);
  await expect(page.getByText(`You said: "${prompt}"`, {exact:true})).toBeVisible({timeout:30_000});
  await expect(page.getByLabel('Stop generating')).toBeHidden({timeout:30_000});
  await send(page, '[tool:fetch_url {"url":"https://example.com/home-approval"}]');
  await expect(page.getByRole('button', {name:'Allow once'})).toBeVisible();
  const panel = page.getByRole('complementary', {name:`${botName} activity and outputs`});
  await expect(panel.getByText('Needs approval',{exact:true}).first()).toBeVisible({timeout:20_000});
  await expect(panel.getByRole('region',{name:'Recent activity'}).getByText('Needs approval',{exact:false})).toBeVisible();
  await page.getByRole('button', {name:'Bot chat history'}).click();
  await page.getByRole('menuitem', {name:'Start fresh home (/new)'}).click();
  await expect(page.getByRole('status', {name:'Command result'})).toContainText('unfinished reply or approval');
  await expect(page).toHaveURL(home);
  await page.reload();
  await expect(page.getByRole('button', {name:'Allow once'})).toBeVisible();
  await page.getByRole('button', {name:'Deny', exact:true}).click();
  await expect(page.getByText('Read page — denied', {exact:true})).toBeVisible();
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",[id])).rows[0]?.status).toBe('succeeded');
  await send(page, '/reset');
  await expect(page).not.toHaveURL(home);
  await expect(page.locator("header").getByRole("heading", { name: botName, exact: true })).toBeVisible();
});

test("ordinary replies stay out of Activity and Outputs; returned files download and mobile panel closes accessibly",async({page,browser})=>{
  await login(page,"alice");await openBot(page,botName);
  const home=page.url();
  await send(page,"Prepare the project handoff");
  await expect(page.getByText('You said: "Prepare the project handoff"',{exact:true})).toBeVisible();
  const panel=page.getByRole('complementary',{name:`${botName} activity and outputs`});
  // Empty sections stay out of the way: one quiet line instead of empty Activity/Outputs headings.
  await expect(panel.getByText('Nothing needs attention. Active work, routine results and files will show up here.')).toBeVisible({timeout:20_000});
  await expect(panel.getByRole('region',{name:'Recent activity'})).toHaveCount(0);
  await expect(panel.getByRole('region',{name:'Outputs'})).toHaveCount(0);
  await expect(panel.getByRole('link',{name:/Prepare the project handoff/})).toHaveCount(0);
  // A real stored file, referenced as an assistant result, can be downloaded from Outputs.
  const upload = await page.request.post('/api/files',{multipart:{file:{name:'Audit-report.txt',mimeType:'text/plain',buffer:Buffer.from('Verified test report')}}});
  expect(upload.ok()).toBe(true);
  const file = await upload.json(); uploadedFiles.push(file.id);
  await pool.query("INSERT INTO messages (id,conversation_id,role,parts,search_text) VALUES ($1,$2,'assistant',$3,'Returned audit report')",[`file${Date.now()}`,priorId,JSON.stringify([{type:'file',url:file.url,filename:file.filename,mediaType:file.mediaType}])]);
  const output = panel.getByRole('region',{name:'Outputs'}).getByRole('link',{name:/Audit-report.txt/});
  await expect(output).toBeVisible({timeout:20_000});
  const download = await page.request.get(file.url);
  expect(download.status()).toBe(200); expect(await download.text()).toBe('Verified test report');
  const foreign = await browser.newContext();const bob = await foreign.newPage();
  await login(bob,'bob');expect((await bob.request.get(file.url)).status()).toBe(404);await foreign.close();
  await page.getByRole('button',{name:'Hide bot panel'}).click();
  await expect(panel).toBeHidden();await expect(page).toHaveURL(home);
  await page.getByRole('button',{name:'Show bot panel'}).click();await expect(panel).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Show bot panel'}).click();
  await expect(page.getByRole('dialog',{name:`${botName} activity`})).toBeVisible();
  await expect(output).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(home);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("deleted-bot history remains reachable, and a home can be deleted from its header menu",async({page})=>{
  await login(page,'alice');
  const owner=(await pool.query("SELECT id FROM users WHERE upn='alice@corp.local'")).rows[0].id;
  const temporary=`deletedBot${Date.now()}`, chat=`deletedChat${Date.now()}`, message=`deletedMsg${Date.now()}`;
  try {
    await pool.query("INSERT INTO bots (id,owner_id,name,app_id,visibility) SELECT $1,$2,'Deleted bot',app_id,'org' FROM bots WHERE id=$3",[temporary,owner,botId]);
    await pool.query("INSERT INTO conversations (id,user_id,bot_id,title,is_bot_home,current_leaf_id) VALUES ($1,$2,$3,'History of deleted bot',true,$4)",[chat,owner,temporary,message]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,parts,search_text) VALUES ($1,$2,'user',$3,'Retained after bot deletion')",[message,chat,JSON.stringify([{type:'text',text:'Retained after bot deletion'}])]);
    await pool.query('DELETE FROM bots WHERE id=$1',[temporary]);
    await page.goto(`/c/${chat}`);
    await expect(page.getByText('Retained after bot deletion',{exact:true})).toBeVisible();
    const history = page.locator(`nav a[href="/c/${chat}"]`);
    await expect(history).toHaveAttribute('aria-current','page');
    await history.locator('..').getByRole('button',{name:'Chat options'}).click();
    await expect(page.getByRole('menuitem',{name:'Archive',exact:true})).toBeVisible();
    await expect(page.getByRole('menuitem',{name:'Delete',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await openBot(page,botName); const home = page.url().split('/c/')[1];
    await page.getByRole('button',{name:'Bot chat history'}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('menuitem',{name:'Delete',exact:true}).click();
    await page.waitForURL('/');
    expect((await pool.query('SELECT id FROM conversations WHERE id=$1',[home])).rows).toHaveLength(0);
  } finally {
    await pool.query('DELETE FROM conversations WHERE id=$1',[chat]);
    await pool.query('DELETE FROM bots WHERE id=$1',[temporary]);
  }
});

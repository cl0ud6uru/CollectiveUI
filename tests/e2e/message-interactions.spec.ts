import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const screens=process.env.INTERACTIONS_SCREENSHOTS??'/tmp/collective-message-interactions-screenshots';
const input=(page:Page)=>page.getByRole('combobox',{name:'Message'});
async function requests(page:Page){return(await page.request.get('/fixture/requests')).json();}
test.beforeAll(async()=>{await mkdir(screens,{recursive:true});});
test.beforeEach(async({page})=>{
  page.on('pageerror',error=>console.error('[message fixture page error]',error.stack??error.message));
  page.on('console',message=>{if(message.type()==='error')console.error('[message fixture console]',message.text());});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.request.get('/fixture/reset'); await page.goto('/');await expect(input(page)).toBeEnabled();
});
test('Tab accepts the highlighted bot; arrows, Escape, Shift+Tab and unknown names do not send',async({page})=>{
  await input(page).fill('@Re');await expect(page.getByRole('option',{name:'@Researcher',exact:true})).toHaveAttribute('aria-selected','true');
  await page.screenshot({path:screens+'/after-mention-desktop.png'});
  await input(page).press('Tab');await expect(input(page)).toHaveValue('@Researcher ');expect(await requests(page)).toHaveLength(0);
  await input(page).fill('@');await input(page).press('ArrowDown');await expect(page.getByRole('option',{name:'@Writer',exact:true})).toHaveAttribute('aria-selected','true');
  await input(page).press('Tab');await expect(input(page)).toHaveValue('@Writer ');expect(await requests(page)).toHaveLength(0);
  await input(page).fill('@ev');await input(page).press('Tab');await expect(input(page)).toHaveValue('@everyone ');
  await input(page).fill('@Re');await input(page).press('Escape');await expect(page.getByRole('listbox',{name:'Group bots'})).toHaveCount(0);
  await input(page).press('Tab');await expect(input(page)).toHaveValue('@Re');
  await input(page).fill('@Re');await input(page).press('Shift+Tab');await expect(input(page)).toHaveValue('@Re');
  await input(page).fill('@Unknown');await input(page).press('Tab');await expect(input(page)).toHaveValue('@Unknown');expect(await requests(page)).toHaveLength(0);
});
test('speaker reply selection, repeated clicks, replacement and cancellation preserve the draft',async({page})=>{
  await input(page).fill('Please expand this');
  const research=page.getByRole('button',{name:'Reply to Researcher',exact:true});
  await research.nth(0).click();await expect(input(page)).toHaveValue('@Researcher, Please expand this');await expect(page.getByRole('status')).toContainText('Research findings:');
  await research.nth(0).click();await expect(input(page)).toHaveValue('@Researcher, Please expand this');
  await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await expect(input(page)).toHaveValue('@Writer, Please expand this');await expect(page.getByRole('status')).toContainText('First draft:');
  await research.nth(1).click();await expect(page.getByRole('status')).toContainText('Revised findings:');
  await page.screenshot({path:screens+'/after-reply-desktop.png'});
  await page.getByRole('button',{name:'Cancel reply',exact:true}).click();await expect(input(page)).toHaveValue('Please expand this');await expect(page.getByRole('status')).toHaveCount(0);
  await input(page).fill('@Researcher My own mention');await research.nth(0).click();await page.getByRole('button',{name:'Cancel reply',exact:true}).click();await expect(input(page)).toHaveValue('@Researcher My own mention');
  expect(await requests(page)).toHaveLength(0);
});
test('sending carries only a reply reference and displays the saved quote',async({page})=>{
  await page.getByRole('button',{name:'Reply to Writer',exact:true}).focus();await page.keyboard.press('Enter');await input(page).fill('@Writer Make this shorter');
  await input(page).press('Enter');await expect(page.getByText('Synthetic reply accepted.',{exact:true})).toBeVisible();
  const sent=(await requests(page))[0];expect(sent.replyTo).toEqual({messageId:'source-answer',speakerIndex:2});
  expect(sent.message.parts).toEqual([{type:'text',text:'@Writer Make this shorter'}]);expect(sent.message.metadata).toBeUndefined();
  await expect(page.getByRole('button',{name:'Cancel reply'})).toHaveCount(0);await expect(page.getByLabel('In reply to Writer')).toContainText('First draft:');
  await page.screenshot({path:screens+'/after-saved-reply.png'});
});
test('a rejected unsaved reply restores its text and preview',async({page})=>{
  await page.request.get('/fixture/reset?reject');await input(page).fill('Retry this draft');await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await input(page).press('Enter');
  await expect(input(page)).toHaveValue('@Writer, Retry this draft');await expect(page.getByRole('button',{name:'Cancel reply',exact:true})).toBeVisible();await expect(page.getByRole('status')).toContainText('First draft:');
  expect(await requests(page)).toHaveLength(1);
  await page.getByRole('button',{name:'Reply to Researcher',exact:true}).nth(0).click();await expect(input(page)).toHaveValue('@Researcher, Retry this draft');
  await page.getByRole('button',{name:'Cancel reply',exact:true}).click();await expect(input(page)).toHaveValue('Retry this draft');
});
test('changing branches cancels the quote and its generated address',async({page})=>{
  await page.goto('/?branches');await input(page).fill('Keep this draft');await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await expect(input(page)).toHaveValue('@Writer, Keep this draft');
  await page.getByRole('button',{name:'Next version',exact:true}).click();await expect(page.getByText('Alternate draft version.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Cancel reply'})).toHaveCount(0);await expect(input(page)).toHaveValue('Keep this draft');
});
test('a rejected generated-only address can be replaced and cancelled',async({page})=>{
  await page.request.get('/fixture/reset?reject');await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await input(page).press('Enter');
  await expect(input(page)).toHaveValue('@Writer,');await expect(page.getByRole('button',{name:'Cancel reply'})).toBeVisible();
  await page.getByRole('button',{name:'Reply to Researcher',exact:true}).nth(0).click();await expect(input(page)).toHaveValue('@Researcher, ');
  await page.getByRole('button',{name:'Cancel reply'}).click();await expect(input(page)).toHaveValue('');expect(await requests(page)).toHaveLength(1);
});
test('regenerating a quoted answer cancels its quote and generated address',async({page})=>{
  await input(page).fill('Keep this draft');await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await page.getByRole('button',{name:'Regenerate',exact:true}).click();
  await expect(page.getByText('Synthetic reply accepted.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Cancel reply'})).toHaveCount(0);await expect(input(page)).toHaveValue('Keep this draft');
});
test('retrying a failed partial answer clears its selected quote and address',async({page})=>{
  await page.request.get('/fixture/reset?stream-failure');await input(page).fill('Create a draft');await input(page).press('Enter');
  await expect(page.getByText('Synthetic partial draft.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
  await input(page).fill('Keep this draft');await page.getByRole('button',{name:'Reply to Writer',exact:true}).last().click();await expect(input(page)).toHaveValue('@Writer, Keep this draft');
  await page.request.get('/fixture/reset');await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByText('Synthetic reply accepted.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Cancel reply'})).toHaveCount(0);await expect(input(page)).toHaveValue('Keep this draft');
});
test('attachment-only user messages have no inert Reply action',async({page})=>{
  await page.goto('/?attachment');await expect(page.getByRole('button',{name:'Reply to your message',exact:true})).toHaveCount(0);
});
test('mobile touch targets and suggestions fit the viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.getByRole('button',{name:'Reply to Writer',exact:true}).click();await page.screenshot({path:screens+'/after-reply-mobile-dark.png'});await input(page).fill('@Re');await page.getByRole('option',{name:'@Researcher',exact:true}).click();await expect(input(page)).toHaveValue('@Researcher ');
  const target=await page.getByRole('button',{name:'Cancel reply',exact:true}).boundingBox();expect(target?.width).toBeGreaterThanOrEqual(44);expect(target?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await input(page).fill('@');await page.screenshot({path:screens+'/after-mention-mobile-dark.png'});expect(await requests(page)).toHaveLength(0);
});
test('read-only chats expose no reply controls or enabled composer',async({page})=>{
  await page.goto('/?readonly');await expect(page.getByRole('button',{name:/Reply to/})).toHaveCount(0);await expect(input(page)).toBeDisabled();
});

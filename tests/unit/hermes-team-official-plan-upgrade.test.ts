import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe,expect,it } from 'vitest';
const folder='src/db/migrations';
const snapshot=(version:number)=>JSON.parse(readFileSync(`${folder}/meta/${String(version).padStart(4,'0')}_snapshot.json`,'utf8'));
const sql=(file:string)=>readFileSync(`${folder}/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]');

describe('official personal account migration44',()=>{
 it('preserves all0–43 artifacts and extends the canonical43 snapshot only with the declared personal fields/table',()=>{
  const baseline=JSON.parse(readFileSync('tests/fixtures/hermes-team-official-plan-baseline.json','utf8'));
  for(const [file,hash] of Object.entries(baseline.files))expect(createHash('sha256').update(readFileSync(file)).digest('hex'),file).toBe(hash);
  const journal=JSON.parse(readFileSync(`${folder}/meta/_journal.json`,'utf8'));expect(journal.entries.slice(0,44)).toEqual(baseline.journalEntries);expect(journal.entries[44]).toMatchObject({idx:44,tag:'0044_hermes_team_official_plan_connections'});
  const prior=snapshot(43),next=snapshot(44);expect(next.prevId).toBe(prior.id);
  for(const [name,table] of Object.entries(prior.tables)){
   const current=structuredClone(next.tables[name]);
   if(name==='public.hermes_team_chats'){delete current.columns.model_choice;delete current.checkConstraints.hermes_team_chat_model_choice_check;}
   if(name==='public.hermes_team_candidate_contexts'){delete current.columns.personal_binding_hash;delete current.checkConstraints.hermes_team_candidate_personal_binding_check;}
   expect(current,name).toEqual(table);
  }
  expect(Object.keys(next.tables).filter(name=>!(name in prior.tables))).toEqual(['public.official_plan_connections']);
 });
 it('upgrades retained private chats, terminal capabilities, private learning receipts and usage without rewriting them',async()=>{
  const client=new PGlite();await client.waitReady;
  try{
   for(const file of readdirSync(folder).filter(file=>file.endsWith('.sql') && Number(file.slice(0,4))<=43).sort())await client.exec(sql(file));
   await client.exec(`
    INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES('upgrade-owner','upgrade@test.invalid','Owner','local','local');
    INSERT INTO bots(id,owner_id,name) VALUES('upgrade-team','upgrade-owner','Team');
    INSERT INTO hermes_team_definitions(bot_id,model_policy,updated_by) VALUES('upgrade-team','{"mode":"personal_required"}','upgrade-owner');
    INSERT INTO hermes_team_profiles(id,bot_id,user_id,mode,owner_key,request_id,state,binding) VALUES('upgrade-profile','upgrade-team','upgrade-owner','member','upgrade-owner','upgrade-request','connection_needed','{"identity":"retained-private"}');
    INSERT INTO conversations(id,user_id,bot_id,title) VALUES('upgrade-chat','upgrade-owner','upgrade-team','Private history');
    INSERT INTO hermes_team_chats(conversation_id,profile_id,mode) VALUES('upgrade-chat','upgrade-profile','member');
    INSERT INTO agent_runs(id,user_id,conversation_id,bot_id,message_id,status) VALUES('upgrade-run','upgrade-owner','upgrade-chat','upgrade-team','upgrade-message','succeeded');
    INSERT INTO hermes_team_candidate_contexts(id,run_id,bot_id,profile_id,actor_id,session_version,definition_version,mode,model_route,personal_connection_id,binding_hash,model_tokens,tool_token_hash,expires_at,revoked_at,retirement_state,native_stopped_at)
     VALUES('upgrade-context','upgrade-run','upgrade-team','upgrade-profile','upgrade-owner',0,1,'member','{}','retained-codex-owner',repeat('a',64),'{}',repeat('b',64),now(),now(),'confirmed',now());
    INSERT INTO hermes_team_learning_handoffs(id,source_context_id,review_id,actor_id,bot_id,profile_id,session_version,definition_version,mode,binding_hash,route_hash,snapshot_hash,snapshot_bytes,payload_enc,expires_at,state)
     VALUES('upgrade-review','upgrade-context','00000000-0000-4000-8000-000000000000','upgrade-owner','upgrade-team','upgrade-profile',0,1,'member',repeat('a',64),repeat('b',64),repeat('c',64),10,'v2.private-upgrade-fixture',now(),'needs_attention');
   `);
   const tables=['users','bots','hermes_team_profiles','conversations','agent_runs','hermes_team_candidate_contexts','hermes_team_learning_handoffs'];
   const prior=new Map<string,unknown>();for(const table of tables)prior.set(table,(await client.query(`SELECT * FROM ${table}`)).rows);
   await client.exec(sql('0044_hermes_team_official_plan_connections.sql'));
   for(const table of tables){const after=(await client.query<Record<string,unknown>>(`SELECT * FROM ${table}`)).rows;if(table==='hermes_team_candidate_contexts'){expect(after[0].personal_binding_hash).toBeNull();delete after[0].personal_binding_hash;}expect(after,table).toEqual(prior.get(table));}
   expect((await client.query('SELECT model_choice FROM hermes_team_chats')).rows).toEqual([{model_choice:'default'}]);expect((await client.query('SELECT * FROM official_plan_connections')).rows).toEqual([]);
   await expect(client.exec("UPDATE hermes_team_candidate_contexts SET personal_connection_id='other-owner' WHERE id='upgrade-context'")).rejects.toThrow('Native personal account binding is immutable');
  }finally{await client.close();}
 },45000);
});

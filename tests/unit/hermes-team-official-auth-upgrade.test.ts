import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe,expect,it } from 'vitest';
const folder='src/db/migrations';
const snapshot=(version:number)=>JSON.parse(readFileSync(`${folder}/meta/${String(version).padStart(4,'0')}_snapshot.json`,'utf8'));
const sql=(file:string)=>readFileSync(`${folder}/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]');
describe('canonical dormant auth45 migration',()=>{
 it('preserves every prior0–44 artifact and extends44 with exactly the auth receipt tables',()=>{
  const baseline=JSON.parse(readFileSync('tests/fixtures/hermes-team-official-auth-baseline.json','utf8'));
  for(const [file,hash] of Object.entries(baseline.files))expect(createHash('sha256').update(readFileSync(file)).digest('hex'),file).toBe(hash);
  const journal=JSON.parse(readFileSync(`${folder}/meta/_journal.json`,'utf8'));expect(journal.entries.slice(0,45)).toEqual(baseline.journalEntries);expect(journal.entries[45]).toMatchObject({idx:45,tag:'0045_hermes_team_official_auth'});
  const prior=snapshot(44),next=snapshot(45);expect(next.prevId).toBe(prior.id);for(const [name,table] of Object.entries(prior.tables))expect(next.tables[name],name).toEqual(table);
  expect(Object.keys(next.tables).filter(name=>!(name in prior.tables))).toEqual(['public.official_plan_auth_attempts','public.official_plan_auth_operations']);
 });
 it('upgrades an existing official account without changing private proofs or credentials and prevents receipt resurrection',async()=>{
  const client=new PGlite();await client.waitReady;
  try{
   for(const file of readdirSync(folder).filter(file=>file.endsWith('.sql')&&Number(file.slice(0,4))<=44).sort())await client.exec(sql(file));
   await client.exec(`INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES('owner','owner@test.invalid','Owner','local','local');
    INSERT INTO official_plan_connections(id,user_id,client_id,host_id,subject,scopes,expires_at,token_bundle_enc,catalog,catalog_revision,catalog_expires_at,verified_at) VALUES('account','owner','issued','host','subject','["chatgpt.tokens.use.direct","resource.invoke"]',now()+interval '1 hour','v2.retained-private-cipher','["retained-model"]',1,now()+interval '5 minutes',now());`);
   const before=(await client.query('SELECT * FROM official_plan_connections')).rows;
   await client.exec(sql('0045_hermes_team_official_auth.sql'));expect((await client.query('SELECT * FROM official_plan_connections')).rows).toEqual(before);
   await client.exec(`INSERT INTO official_plan_auth_attempts(id,user_id,session_version,transport_id,host_id,redirect_uri,state_hash,return_token_hash,secret_enc,expires_at) VALUES('attempt','owner',0,'transport','host','http://127.0.0.1:1455/auth/callback',repeat('a',64),repeat('b',64),'v2.private-attempt',now()+interval '10 minutes');
    UPDATE official_plan_auth_attempts SET state='exchanging',callback_hash=repeat('c',64) WHERE id='attempt';
    UPDATE official_plan_auth_attempts SET state='needs_attention' WHERE id='attempt';
    INSERT INTO official_plan_auth_operations(id,user_id,connection_id,session_version,credential_revision,kind) VALUES('rotation','owner','account',0,1,'refresh');
    UPDATE official_plan_auth_operations SET state='needs_attention' WHERE id='rotation';`);
   await expect(client.exec("UPDATE official_plan_auth_attempts SET state='pending' WHERE id='attempt'")).rejects.toThrow('cannot be replayed');
   await expect(client.exec("UPDATE official_plan_auth_attempts SET callback_hash=repeat('d',64) WHERE id='attempt'")).rejects.toThrow('immutable');
   await expect(client.exec("UPDATE official_plan_auth_operations SET state='running' WHERE id='rotation'")).rejects.toThrow('cannot be replayed');
   await expect(client.exec("INSERT INTO official_plan_auth_operations(id,user_id,connection_id,session_version,credential_revision,kind) VALUES('retry','owner','account',0,1,'refresh')")).rejects.toThrow();
  }finally{await client.close();}
 },45000);
});

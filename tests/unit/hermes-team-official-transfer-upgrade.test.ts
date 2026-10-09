import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
const folder = 'src/db/migrations';
const snapshot = (index: number) => JSON.parse(readFileSync(`${folder}/meta/${String(index).padStart(4, '0')}_snapshot.json`, 'utf8'));
const migration = (name: string) => readFileSync(`${folder}/${name}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]');

describe('Official protected-transfer migration0048', () => {
  it('extends the canonical47 snapshot only with transfer receipts and nullable connection provenance', () => {
    const prior = snapshot(47), next = snapshot(48); expect(next.prevId).toBe(prior.id);
    for (const [name, table] of Object.entries(prior.tables)) { const current = structuredClone(next.tables[name]); if (name === 'public.official_plan_connections') delete current.columns.provenance; expect(current, name).toEqual(table); }
    expect(Object.keys(next.tables).filter(name => !(name in prior.tables))).toEqual(['public.official_plan_transfers']);
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')); expect(journal.entries[48]).toMatchObject({ idx: 48, tag: '0048_official_plan_vm_transfers' });
  });
  it('preserves the prior personal account, profile binding and private conversation across upgrade', async () => {
    const client = new PGlite(); try {
      for (const name of readdirSync(folder).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) <= 47).sort()) await client.exec(migration(name));
      await client.exec(`
        INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES('owner','owner@test.invalid','Owner','local','local');
        INSERT INTO bots(id,owner_id,name) VALUES('audit','owner','Shared Audit');
        INSERT INTO hermes_team_definitions(bot_id,updated_by,model_policy) VALUES('audit','owner','{"mode":"personal_required"}');
        INSERT INTO hermes_team_profiles(id,bot_id,mode,user_id,owner_key,request_id,state,binding) VALUES('profile','audit','member','owner','owner','retained-request','ready','{"runtimeId":"retained-runtime","volume":"retained-volume"}');
        INSERT INTO conversations(id,user_id,bot_id,title) VALUES('private','owner','audit','Retained private history');
        INSERT INTO hermes_team_chats(conversation_id,profile_id,mode,model_choice) VALUES('private','profile','member','personal');
        INSERT INTO official_plan_connections(id,user_id,client_id,host_id,subject,scopes,expires_at,token_bundle_enc,catalog,catalog_revision,catalog_expires_at,verified_at) VALUES('account','owner','issued-client','retained-host','verified-subject','["chatgpt.tokens.use.direct","resource.invoke"]',now()+interval '1 hour','v2.retained-ciphertext','["synthetic-model"]',1,now()+interval '5 minutes',now());
      `);
      const tables = ['users', 'bots', 'hermes_team_definitions', 'hermes_team_profiles', 'conversations', 'hermes_team_chats', 'official_plan_connections'];
      const prior = new Map<string, unknown>(); for (const table of tables) prior.set(table, (await client.query(`SELECT * FROM ${table}`)).rows);
      await client.exec(migration('0048_official_plan_vm_transfers.sql'));
      for (const table of tables) { const after = (await client.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows; if (table === 'official_plan_connections') { expect(after[0].provenance).toBeNull(); delete after[0].provenance; } expect(after, table).toEqual(prior.get(table)); }
      expect((await client.query('SELECT * FROM official_plan_transfers')).rows).toEqual([]);
    } finally { await client.close(); }
  }, 60000);
});

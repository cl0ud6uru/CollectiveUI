import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite, type QueryOptions, type Results, type Transaction } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

// Database-only upgrade evidence: no application/broker imports, credentials, volumes or inference.
// PGlite lacks pgvector. Adapt only execution SQL; Drizzle still reads/hashes the exact checked-in files.
// This does not replace a disposable PostgreSQL/pgvector upgrade or native-image volume test.
const original = path.resolve('src/db/migrations');
type Entry = { idx: number; when: number; tag: string };
type Journal = { entries: Entry[] };
type Row = Record<string, unknown>;
type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown>; checkConstraints: Record<string, unknown> }> };
const legacyTables = ['users', 'groups', 'group_members', 'app_access', 'bot_access', 'bot_user_access',
  'provider_connections', 'ai_apps', 'bots', 'docker_hermes_enrollments', 'hermes_connections',
  'hermes_provisions', 'conversations', 'messages', 'agent_runs', 'hermes_chat_settings', 'hermes_run_contexts',
  'memories', 'skills'] as const;
const learningTables = ['bot_learnings', 'bot_learning_revisions', 'bot_learning_reviews'] as const;
const journal = async () => JSON.parse(await readFile(path.join(original, 'meta/_journal.json'), 'utf8')) as Journal;
const snapshot = async (index: number) => JSON.parse(await readFile(path.join(original, `meta/${String(index).padStart(4, '0')}_snapshot.json`), 'utf8')) as Snapshot;
const rows = async (client: PGlite, table: string) => (await client.query<Row>(`SELECT * FROM "${table}"`)).rows
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const history = async (client: PGlite) => (await client.query<{ id: number; hash: string; created_at: number }>('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
const retained = async (client: PGlite, tables: readonly string[]) => Object.fromEntries(await Promise.all(tables.map(async table => [table, await rows(client, table)])));

async function assertRetained(client: PGlite, before: Record<string, Row[]>) {
  for (const [table, data] of Object.entries(before)) {
    let after = await rows(client, table);
    if (table === 'bots') after = after.map(({ hermes_team: team, ...row }) => { expect(team).toBe(false); return row; });
    if (table === 'bot_learnings' && data.length && !Object.hasOwn(data[0], 'pinned')) {
      after = after.map(({ pinned, use_count, last_used_at, last_curated_at, ...row }) => {
        expect({ pinned, use_count, last_used_at, last_curated_at }).toEqual({ pinned: false, use_count: 0, last_used_at: null, last_curated_at: null });
        return row;
      });
    }
    if (table === 'bot_learning_revisions' && data.length && !Object.hasOwn(data[0], 'kind')) {
      after = after.map(({ kind, ...row }) => { expect(kind).toBe('preference'); return row; });
    }
    expect(after).toEqual(data);
  }
}

async function seedPersonalData(client: PGlite) {
  const binding = { bindingId: 'a'.repeat(32), ownerId: 'upgrade-owner', botId: 'personal-bot', appId: 'personal-app',
    profile: 'retained-personal', identity: '41:10001', name: 'Personal Hermes', runtimeId: createHash('sha256').update('upgrade-owner').digest('hex') };
  await client.exec(`
    INSERT INTO users(id,upn,name,auth_source,is_admin) VALUES
      ('upgrade-admin','admin@upgrade.invalid','Admin','ldap',true),
      ('upgrade-owner','owner@upgrade.invalid','Owner','ldap',false),
      ('upgrade-member','member@upgrade.invalid','Member','ldap',false);
    INSERT INTO groups(id,name) VALUES ('upgrade-audience','Retained audience');
    INSERT INTO group_members(group_id,user_id) VALUES ('upgrade-audience','upgrade-owner');
    INSERT INTO provider_connections(id,name,secret_enc,organization,project,created_by)
      VALUES ('saved-provider','Retained provider','unusable-fixture-placeholder','fixture-org','fixture-project','upgrade-admin');
    INSERT INTO ai_apps(id,name,provider,model,provider_connection_id,is_public)
      VALUES ('company-app','Company model','openai','synthetic','saved-provider',false);
  `);
  await client.query('INSERT INTO ai_apps(id,name,provider,base_url,model,provider_config,supports_tools,is_public) VALUES ($1,$2,$3,$4,$5,$6,true,false)',
    ['personal-app', 'Personal Hermes', 'hermes', 'http://local-hermes.invalid', 'native-profile', JSON.stringify({ profile: '', allowedModels: '', approvalTimeoutSec: 300, docker: binding })]);
  await client.query('INSERT INTO ai_apps(id,name,provider,base_url,model,provider_config,is_public) VALUES ($1,$2,$3,$4,$5,$6,false)',
    ['managed-app', 'Managed Hermes', 'hermes', 'http://127.0.0.1:19000', 'native', JSON.stringify({ managed: { provider: 'openai', model: 'synthetic', skills: [], toolsets: [] }, managedBotId: 'managed-bot' })]);
  // Mandatory legacy secret columns receive inert markers, never keys, encrypted grants or decryptable credentials.
  await client.exec(`
    INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES
      ('personal-bot','upgrade-owner','Personal Hermes','personal-app','private'),
      ('managed-bot','upgrade-owner','Managed Hermes','managed-app','private'),
      ('company-bot','upgrade-owner','Native harness','company-app','groups');
    INSERT INTO app_access(app_id,group_id) VALUES ('company-app','upgrade-audience');
    INSERT INTO bot_access(bot_id,group_id) VALUES ('company-bot','upgrade-audience');
    INSERT INTO bot_user_access(bot_id,user_id) VALUES ('company-bot','upgrade-member');
    INSERT INTO docker_hermes_enrollments(user_id,enabled,cleanup,changed_by) VALUES
      ('upgrade-owner',true,'none','upgrade-admin'), ('upgrade-member',false,'stopped','upgrade-admin');
    INSERT INTO hermes_connections(id,user_id,boundary_id,dashboard_url,runs_url,protocol,expected_version,expected_display_version,provider,secret_enc,quota)
      VALUES ('managed-boundary','upgrade-owner','retained-volume-boundary','http://127.0.0.1:19000','http://127.0.0.1:19001','dashboard-be5e9f72-multiplexer-v1','fixture','fixture','openai','unusable-fixture-placeholder',3);
    INSERT INTO hermes_provisions(id,user_id,bot_id,app_id,connection_id,profile,key_slot,spec_hash,status,create_attempted)
      VALUES ('retained-provision','upgrade-owner','managed-bot','managed-app','managed-boundary','retained-managed-profile',0,'retained-spec-hash','ready',true);
    INSERT INTO conversations(id,user_id,bot_id,app_id,title) VALUES
      ('personal-chat','upgrade-owner','personal-bot','personal-app','Keep private history'),
      ('managed-chat','upgrade-owner','managed-bot','managed-app','Keep managed history'),
      ('company-chat','upgrade-owner','company-bot','company-app','Keep native learning');
    INSERT INTO messages(id,conversation_id,role,parts) VALUES
      ('personal-prompt','personal-chat','user','[{"type":"text","text":"Retained synthetic private prompt"}]'),
      ('managed-prompt','managed-chat','user','[{"type":"text","text":"Retained synthetic managed prompt"}]'),
      ('company-prompt','company-chat','user','[{"type":"text","text":"Remember a synthetic preference"}]'),
      ('company-reply','company-chat','assistant','[{"type":"text","text":"Retained synthetic reply"}]');
    INSERT INTO agent_runs(id,user_id,conversation_id,app_id,bot_id,message_id,parent_message_id,status) VALUES
      ('personal-run','upgrade-owner','personal-chat','personal-app','personal-bot','personal-response','personal-prompt','waiting'),
      ('managed-run','upgrade-owner','managed-chat','managed-app','managed-bot','managed-response','managed-prompt','waiting'),
      ('learning-run','upgrade-owner','company-chat','company-app','company-bot','company-reply','company-prompt','succeeded');
    INSERT INTO hermes_chat_settings(conversation_id,target_key,model,revision)
      VALUES ('personal-chat','retained-personal-target','retained-model',4),
        ('managed-chat','retained-managed-target','retained-model',2);
    INSERT INTO hermes_run_contexts(run_id,target_key,model,upstream_run_id,stop_state,provision_id)
      VALUES ('personal-run','retained-personal-target','retained-model','retained-upstream-run','pending',null),
        ('managed-run','retained-managed-target','retained-model','retained-managed-upstream-run','none','retained-provision');
    INSERT INTO memories(id,user_id,bot_id,content,source_conversation_id,pinned)
      VALUES ('private-memory','upgrade-owner','personal-bot','Retained synthetic personal memory','personal-chat',true);
    INSERT INTO skills(id,owner_id,bot_id,slug,name,description,instructions,version)
      VALUES ('private-skill','upgrade-owner','personal-bot','private-procedure','Personal procedure','Synthetic','Retained personal steps',3);
  `);
}

async function seedLearning(client: PGlite, usage = false) {
  const content = JSON.stringify({ name: 'Retained procedure', description: 'Synthetic', instructions: 'Keep native learning', expectedOutput: '', boundaries: '' });
  await client.query(`INSERT INTO bot_learnings(id,bot_id,user_id,topic,kind,status,content,verification,version) VALUES
    ('private-learning','company-bot','upgrade-owner','private-topic','preference','active',$1,'Synthetic evidence',2),
    ('shared-learning','company-bot',null,'shared-topic','procedure','pending',$1,'Synthetic evidence',1)`, [content]);
  await client.query(`INSERT INTO bot_learning_revisions(id,learning_id,version,status,content,verification,source_conversation_id,source_run_id${usage ? ',kind' : ''}) VALUES
    ('learning-revision-1','private-learning',1,'active',$1,'Original evidence','company-chat','learning-run'${usage ? ",'preference'" : ''}),
    ('learning-revision-2','private-learning',2,'active',$1,'Updated evidence','company-chat','learning-run'${usage ? ",'preference'" : ''})`, [content]);
  await client.exec("INSERT INTO bot_learning_reviews(run_id,attempts) VALUES ('learning-run',2)");
  if (usage) await seedLearningUsage(client);
}

async function seedLearningUsage(client: PGlite) {
  await client.exec(`UPDATE bot_learnings SET pinned=true,use_count=7,last_used_at='2026-10-03T15:01:02Z',last_curated_at='2026-10-02T12:13:14Z' WHERE id='private-learning';
    UPDATE bot_learnings SET use_count=13,last_used_at='2026-09-15T03:04:05Z',last_curated_at='2026-09-14T01:02:03Z' WHERE id='shared-learning';`);
}

async function environment() {
  const metadata = await journal();
  const config = { migrationsFolder: original };
  const migrations = readMigrationFiles(config);
  const client = new PGlite();
  await client.waitReady;
  const transaction = client.transaction.bind(client);
  client.transaction = <T>(callback: (tx: Transaction) => Promise<T>) => transaction(async tx => {
    const prepared = tx.query.bind(tx);
    // Legacy files contain multiple commands per breakpoint (and dollar-quoted PL/pgSQL).
    // Preserve their statement text using PGlite's simple-query executor, rather than splitting SQL.
    tx.query = async <T>(text: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> => {
      if (params?.length) return prepared<T>(text, params, options);
      const results = await tx.exec(text, options);
      return (results.at(-1) ?? { rows: [], fields: [], affectedRows: 0 }) as Results<T>;
    };
    return callback(tx);
  });
  let failAdmission = false;
  const database = drizzle(client, { schema: {} });
  const dialect = new PgDialect();
  return { client, metadata, failNextAdmission: () => { failAdmission = true; },
    apply: async (through = 41) => {
      const pending = migrations.filter((_, index) => metadata.entries[index].idx <= through).map((migration, index) => {
        const sql = migration.sql.map(text => text.replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
        if (failAdmission && metadata.entries[index].idx === 40) { failAdmission = false; sql.push('SELECT 1 / 0'); }
        return { ...migration, sql };
      });
      // The same transactional PgDialect migrator used by both PostgreSQL and PGlite wrappers.
      // Preserve readMigrationFiles' real file hashes/timestamps; substitute only unsupported vector SQL.
      await dialect.migrate(pending, database._.session, config);
    },
    close: async () => { await client.close(); } };
}

describe('combined main and Team Bot upgrade history (PGlite, no pgvector or native image)', () => {
  it('keeps all0000–0040 SQL/snapshots and journal entries identical to the independently reviewed reconciliation baseline',async()=>{
    const baseline=JSON.parse(await readFile('tests/fixtures/hermes-team-candidate-baseline.json','utf8')) as {files:Record<string,string>;journalEntries:Journal['entries']};
    for(const [file,hash] of Object.entries(baseline.files))expect(createHash('sha256').update(await readFile(file)).digest('hex'),file).toBe(hash);
    expect((await journal()).entries.slice(0,41)).toEqual(baseline.journalEntries);
  });

  it('preserves native-learning usage snapshots and the exact contiguous 0035–0041 lineage', async () => {
    const entries = (await journal()).entries;
    expect(entries.map(entry => entry.idx)).toEqual(entries.map((_, index) => index));
    for (let index = 1; index < entries.length; index++) expect(entries[index].when).toBeGreaterThan(entries[index - 1].when);
    expect(entries.slice(35, 42).map(entry => entry.tag)).toEqual(['0035_direct_user_permissions', '0036_native_bot_learning', '0037_learning_usage', '0038_hermes_team_bots', '0039_hermes_team_revision_immutability', '0040_hermes_team_admission', '0041_hermes_team_candidate_adapters']);
    const snapshots = await Promise.all([35, 36, 37, 38, 39, 40, 41].map(snapshot));
    snapshots.slice(1).forEach((next, index) => expect(next.prevId).toBe(snapshots[index].id));
    for (const table of learningTables) {
      expect(snapshots[0].tables[`public.${table}`]).toBeUndefined();
      expect(snapshots[1].tables[`public.${table}`]).toBeDefined();
      const usage = structuredClone(snapshots[2].tables[`public.${table}`]);
      if (table === 'bot_learnings') for (const column of ['pinned', 'use_count', 'last_used_at', 'last_curated_at']) delete usage.columns[column];
      if (table === 'bot_learning_revisions') { delete usage.columns.kind; delete usage.checkConstraints.bot_learning_revisions_kind_check; }
      expect(usage).toEqual(snapshots[1].tables[`public.${table}`]);
      for (const next of snapshots.slice(3)) expect(next.tables[`public.${table}`]).toEqual(snapshots[2].tables[`public.${table}`]);
    }
    expect(snapshots[2].tables['public.bot_learnings'].columns.pinned).toMatchObject({ default: false, notNull: true });
    expect(snapshots[2].tables['public.bot_learnings'].columns.use_count).toMatchObject({ default: 0, notNull: true });
    for (const [table, definition] of Object.entries(snapshots[2].tables)) {
      const upgraded = structuredClone(snapshots[3].tables[table]);
      if (table === 'public.bots') delete upgraded.columns.hermes_team;
      expect(upgraded).toEqual(definition);
    }
    expect(snapshots[3].tables['public.bots'].columns.hermes_team).toMatchObject({ default: false, notNull: true });
    expect(snapshots[5].tables['public.hermes_team_run_attribution'].columns.admission).toMatchObject({ type: 'jsonb', notNull: false });
    for (const [table, definition] of Object.entries(snapshots[5].tables)) expect(snapshots[6].tables[table]).toEqual(definition);
    expect(Object.keys(snapshots[6].tables).filter(table => table.startsWith('public.hermes_team_candidate_'))).toHaveLength(3);
  });

  it.each(['fresh', 'main0035', 'main0036', 'main0037'] as const)('preserves %s personal bindings, permissions, history and usage through 0041 and repeated replay', async source => {
    const fixture = await environment();
    try {
      if (source !== 'fresh') {
        await fixture.apply(Number(source.slice(4)));
        await seedPersonalData(fixture.client);
        if (source === 'main0036' || source === 'main0037') await seedLearning(fixture.client, source === 'main0037');
      }
      const tables = source === 'main0036' || source === 'main0037' ? [...legacyTables, ...learningTables] : legacyTables;
      const before = source === 'fresh' ? {} : await retained(fixture.client, tables);
      const prefix = source === 'fresh' ? [] : await history(fixture.client);
      await fixture.apply();
      await assertRetained(fixture.client, before);
      for (const table of Object.keys((await snapshot(41)).tables).filter(table => table.startsWith('public.hermes_team_'))) expect(await rows(fixture.client, table.slice(7))).toEqual([]);
      const applied = await history(fixture.client);
      expect(applied.slice(0, prefix.length)).toEqual(prefix);
      expect(applied.map(row => Number(row.created_at))).toEqual(fixture.metadata.entries.filter(entry => entry.idx <= 41).map(entry => entry.when));
      expect(applied.map(row => row.hash)).toEqual(await Promise.all(fixture.metadata.entries.filter(entry => entry.idx <= 41).map(async entry => createHash('sha256').update(await readFile(path.join(original, `${entry.tag}.sql`))).digest('hex'))));
      expect((await fixture.client.query("SELECT tgname FROM pg_trigger WHERE tgname='hermes_team_revision_immutable_trigger'")).rows).toHaveLength(1);
      expect((await fixture.client.query("SELECT conname FROM pg_constraint WHERE conname='hermes_team_run_admission_check'")).rows).toHaveLength(1);
      if (source === 'fresh') await seedPersonalData(fixture.client);
      if (source === 'fresh' || source === 'main0035') { expect(await rows(fixture.client, 'bot_learnings')).toEqual([]); await seedLearning(fixture.client, true); }
      if (source === 'main0036') await seedLearningUsage(fixture.client);
      expect(await rows(fixture.client, 'bot_learnings')).toMatchObject([{ pinned: true, use_count: 7 }, { pinned: false, use_count: 13 }]);
      expect((await rows(fixture.client, 'bot_learnings')).every(row => row.last_used_at && row.last_curated_at)).toBe(true);
      const replayBefore = await retained(fixture.client, [...legacyTables, ...learningTables]);
      await fixture.apply();
      await fixture.apply();
      expect(await retained(fixture.client, [...legacyTables, ...learningTables])).toEqual(replayBefore);
      expect(await history(fixture.client)).toEqual(applied);
      expect((await rows(fixture.client, 'bots')).every(row => row.hermes_team === false)).toBe(true);
    } finally { await fixture.close(); }
  }, 45000);

  it.each([36, 37])('rolls back pending migrations from main003%i on admission failure and retries without changing prior data or receipts', async baseline => {
    const fixture = await environment();
    try {
      await fixture.apply(baseline); await seedPersonalData(fixture.client); await seedLearning(fixture.client, baseline === 37);
      const before = await retained(fixture.client, [...legacyTables, ...learningTables]);
      const prefix = await history(fixture.client);
      fixture.failNextAdmission();
      await expect(fixture.apply()).rejects.toMatchObject({ cause: { code: '22012' } });
      expect(await history(fixture.client)).toEqual(prefix);
      expect(await retained(fixture.client, [...legacyTables, ...learningTables])).toEqual(before);
      expect((await fixture.client.query("SELECT to_regclass('public.hermes_team_definitions') AS team")).rows).toEqual([{ team: null }]);
      expect((await fixture.client.query("SELECT column_name FROM information_schema.columns WHERE table_name='bots' AND column_name='hermes_team'")).rows).toEqual([]);
      if (baseline === 36) expect((await fixture.client.query("SELECT column_name FROM information_schema.columns WHERE table_name='bot_learnings' AND column_name='pinned'")).rows).toEqual([]);
      await fixture.apply(); await assertRetained(fixture.client, before);
      expect(await history(fixture.client)).toHaveLength(42);
      expect(await rows(fixture.client, 'hermes_team_profiles')).toEqual([]);
    } finally { await fixture.close(); }
  }, 45000);
});

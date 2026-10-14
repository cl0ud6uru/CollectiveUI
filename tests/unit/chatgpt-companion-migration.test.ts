import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
describe('0057 companion attempt storage migration', () => {
  it('adds only owner-bound attempts and enforces capability, expiry, and active-owner constraints', async () => {
    const pg = new PGlite();
    try {
      const [before, after, sql, journal] = await Promise.all([
        readFile('src/db/migrations/meta/0056_snapshot.json', 'utf8').then(JSON.parse),
        readFile('src/db/migrations/meta/0057_snapshot.json', 'utf8').then(JSON.parse),
        readFile('src/db/migrations/0057_chatgpt_companion.sql', 'utf8'),
        readFile('src/db/migrations/meta/_journal.json', 'utf8').then(JSON.parse),
      ]);
      expect(after.prevId).toBe(before.id);
      const { 'public.chatgpt_companion_attempts': added, ...rest } = after.tables;
      expect(rest).toEqual(before.tables); expect(added).toBeDefined();
      expect(journal.entries.at(-1)).toMatchObject({ idx: 57, tag: '0057_chatgpt_companion' });
      await pg.exec("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES ('alice'),('bob');");
      await pg.exec(sql);
      const insert = (id: string, owner: string, hash = "repeat('a',64)", expires = "now()+interval '10 minutes'") =>
        `INSERT INTO chatgpt_companion_attempts(id,user_id,session_version,host_id,origin,launch_hash,payload_enc,expires_at,recovery_until) VALUES ('${id}','${owner}',0,'host','https://portal.invalid',${hash},'v2.test',${expires},now()+interval '1 day')`;
      await pg.exec(insert('123e4567-e89b-42d3-a456-426614174000', 'alice'));
      await expect(pg.exec(insert('123e4567-e89b-42d3-a456-426614174001', 'alice'))).rejects.toThrow(/open_owner/);
      await expect(pg.exec(insert('123e4567-e89b-42d3-a456-426614174001', 'bob', "'plaintext'"))).rejects.toThrow(/secret_check/);
      await expect(pg.exec(insert('123e4567-e89b-42d3-a456-426614174001', 'bob', "repeat('b',64)", "now()+interval '11 minutes'"))).rejects.toThrow(/expiry_check/);
      await expect(pg.exec(insert('123e4567-e89b-42d3-a456-426614174001', 'missing'))).rejects.toThrow(/foreign key/);
      await pg.exec("DELETE FROM users WHERE id='alice'");
      expect((await pg.query('SELECT * FROM chatgpt_companion_attempts')).rows).toEqual([]);
    } finally { await pg.close(); }
  }, 30000);
});

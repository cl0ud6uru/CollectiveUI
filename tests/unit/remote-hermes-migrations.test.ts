import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
const folder = path.resolve('src/db/migrations');
const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {entries: {idx:number;when:number;tag:string}[]};
it('keeps remote Hermes upgrades after merged Live Activities in Drizzle timestamp order', () => {
  const live = journal.entries.findIndex(e => e.tag.endsWith('_live_activities'));
  const connections = journal.entries.findIndex(e => e.tag.endsWith('_remote_hermes_connections'));
  const sessions = journal.entries.findIndex(e => e.tag.endsWith('_remote_hermes_sessions'));
  const reservations = journal.entries.findIndex(e => e.tag.endsWith('_remote_hermes_reservations'));
  expect(live).toBeGreaterThanOrEqual(0);
  expect(connections).toBeGreaterThan(live); expect(sessions).toBeGreaterThan(connections); expect(reservations).toBeGreaterThan(sessions);
  journal.entries.forEach((entry, index) => {
    expect(entry.idx).toBe(index);
    expect(existsSync(path.join(folder, entry.tag + '.sql'))).toBe(true);
    if (index) expect(entry.when).toBeGreaterThan(journal.entries[index - 1].when);
  });
});
it('keeps the snapshot chain consistent across staged remote Hermes migrations', () => {
  const snapshots = [29,30,31,32].map(i => JSON.parse(readFileSync(path.join(folder, `meta/${String(i).padStart(4,'0')}_snapshot.json`), 'utf8')));
  snapshots.slice(1).forEach((snapshot, index) => expect(snapshot.prevId).toBe(snapshots[index].id));
  const key = 'public.remote_hermes_sessions';
  expect(snapshots[1].tables[key]).toBeUndefined();
  expect(snapshots[2].tables[key].columns.queue_request_id).toBeUndefined();
  expect(snapshots[3].tables[key].columns.queue_request_id).toBeDefined();
  expect(snapshots[3].tables['public.live_activities']).toEqual(snapshots[0].tables['public.live_activities']);
});

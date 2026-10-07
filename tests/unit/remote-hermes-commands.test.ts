import { describe, expect, it } from 'vitest';
import contract from '../fixtures/remote-hermes-command-contract.json';
import { nativeCommandCatalog, nativeCommandResult, parseNativeInput, resolveNativeCommand } from '@/lib/remote-hermes/commands';

describe('pinned native Hermes command protocol', () => {
  const catalog = nativeCommandCatalog(contract.catalog);
  it('uses the real registry pairs/canon/commands maps rather than inventing an array schema', () => {
    expect(contract.revision).toBe('f97608f178d1ffeca59860195ab7da295f7c8e5f');
    expect(contract.skill_refusal.error.code).toBe(4018);
    expect(catalog.commands.find(c => c.value === '/compress')).toMatchObject({ available: true });
    expect(catalog.commands.find(c => c.value === '/yolo')).toMatchObject({ kind: 'local', available: true });
    expect(resolveNativeCommand('/COMPACT', catalog).command).toBe('compress');
    expect(resolveNativeCommand('/ctx', catalog).value).toBe('/context');
    expect(nativeCommandResult(contract.skill_dispatch.result)).toMatchObject({ type: 'skill', output: 'Synthetic skill loaded', prefill: 'Synthetic skill instructions\ntask' });
  });
  it('does not advertise terminal/profile/security administration as runnable session controls', () => {
    for (const name of ['/config', '/plugins', '/cron', '/new', '/reset', '/undo', '/retry', '/model']) {
      expect(() => resolveNativeCommand(name, catalog)).toThrow();
    }
    expect(() => resolveNativeCommand('/approvals off', catalog)).toThrow('does not change approval bypass');
    expect(resolveNativeCommand('/yolo on', catalog)).toMatchObject({ kind: 'local', args: 'on' });
    expect(() => resolveNativeCommand('/yolo toggle', catalog)).toThrow('Use /yolo');
    expect(resolveNativeCommand('/yolo', catalog).kind).toBe('local');
  });
  it('projects installed skills while refusing quick/plugin collisions and preserving aliases', () => {
    const c = nativeCommandCatalog({ ...contract.catalog, pairs: [...contract.catalog.pairs, ['/fixture-skill', 'Synthetic skill'], ['/status', 'quick exec']],
      skills: { '/fixture-skill': { usage: 0, origin: 'local' } }, categories: [{ name: 'User commands', pairs: [['/status', 'exec: private command']] }] });
    expect(resolveNativeCommand('/fixture-skill task\nwith lines', c)).toMatchObject({ kind: 'skill', args: 'task\nwith lines' });
    expect(() => resolveNativeCommand('/status', c)).toThrow('Use native Hermes');
  });
  it('fails closed for old or malformed catalogs, bounds entries, and hides raw discovery warnings', () => {
    const c = nativeCommandCatalog({ commands: [{ name: 'yolo' }], warning: 'private-token' });
    expect(c.warning).toContain('compatible command catalog');
    expect(JSON.stringify(c)).not.toContain('private-token');
    expect(() => resolveNativeCommand('/compress', c)).toThrow('not advertised');
    expect(resolveNativeCommand('/commands', c).kind).toBe('local');
    expect(nativeCommandCatalog({ pairs: Array.from({ length: 3000 }, (_, i) => [`/s${i}`, 'skill']), skills: {} }).commands.length).toBeLessThanOrEqual(1005);
    expect(() => resolveNativeCommand('/help', nativeCommandCatalog({ ...contract.catalog, warning: 'plugins failed: private-token' }))).toThrow('discovery is incomplete');
  });
  it.each(['/help', '/compress', '/tools', '/skills'])('rejects unsupported subcommands of %s', name => {
    expect(() => resolveNativeCommand(`${name} approval off`, catalog)).toThrow('does not accept arguments');
  });
  it('keeps shell syntax, paths, prose and explicit literal slash input distinct', () => {
    expect(parseNativeInput(' /yolo ')).toMatchObject({ kind: 'command', name: '/yolo' });
    expect(parseNativeInput('!yolo').kind).toBe('shell');
    expect(parseNativeInput('/tmp/file').kind).toBe('text');
    expect(parseNativeInput('please /help').kind).toBe('text');
    expect(parseNativeInput('//yolo')).toEqual({ kind: 'text', text: '/yolo' });
    expect(parseNativeInput(' /title Multi word\nTitle')).toMatchObject({ kind: 'command', args: 'Multi word\nTitle' });
  });
  it.each(['send', 'skill', 'prefill'])('renders %s display, notices and warnings while keeping inference as an unsent draft', type => {
    expect(nativeCommandResult({ type, message: 'Review this task', display: 'Loaded skill', notice: 'Read first', warning: 'Partial sync' }))
      .toEqual({ type, output: 'Loaded skill\nRead first\nPartial sync', prefill: 'Review this task' });
  });
  it('keeps aliases as drafts and rejects non-text output fields', () => {
    expect(nativeCommandResult({ type: 'alias', target: '/fixture task' }).prefill).toBe('/fixture task');
    expect(nativeCommandResult({ output: { token: 'private' }, warning: ['private'] }).output).toBe('Hermes command completed.');
  });
});

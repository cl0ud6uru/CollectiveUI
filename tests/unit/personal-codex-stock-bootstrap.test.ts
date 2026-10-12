import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspace } from '../../docker/personal-codex/prepare-workspace.mjs';

const fixtures: string[] = [];
const workspace = () => { const root = mkdtempSync(join(tmpdir(), 'codex-stock-bootstrap-')); fixtures.push(root); return root; };
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('stock metadata mount target', () => {
  it('initializes missing metadata and retains populated contents on restart', () => {
    const root = workspace();
    prepareWorkspace(root);
    writeFileSync(join(root, '.codex', 'sentinel'), 'private fixture');
    prepareWorkspace(root);
    expect(readFileSync(join(root, '.codex', 'sentinel'), 'utf8')).toBe('private fixture');
  });
  it('fails closed for metadata symlinks and files without changing their target', () => {
    const root = workspace(), target = workspace();
    writeFileSync(join(target, 'sentinel'), 'private fixture');
    symlinkSync(target, join(root, '.codex'));
    expect(() => prepareWorkspace(root)).toThrow('Unsafe workspace metadata');
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('private fixture');
    const fileRoot = workspace();
    writeFileSync(join(fileRoot, '.codex'), 'private fixture');
    expect(() => prepareWorkspace(fileRoot)).toThrow('Unsafe workspace metadata');
    expect(readFileSync(join(fileRoot, '.codex'), 'utf8')).toBe('private fixture');
  });
});

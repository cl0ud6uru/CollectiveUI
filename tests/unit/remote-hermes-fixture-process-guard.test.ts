import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('permits the synthetic profile alias lookup while preserving fixture process isolation', () => {
  // Exercise the actual guard class without starting the dashboard or spawning a child.
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import ast
from pathlib import Path
import re

source = Path('tests/fixtures/remote-hermes-pinned-dashboard.py')
guard = next(node for node in ast.parse(source.read_text()).body
             if isinstance(node, ast.ClassDef) and node.name == 'GuardedPopen')
class LocalSpawn:
    def __init__(self, *args, **kwargs):
        pass
namespace = {'_popen': LocalSpawn, 'Path': Path, 're': re}
exec(compile(ast.Module(body=[guard], type_ignores=[]), str(source), 'exec'), namespace)
spawn = namespace['GuardedPopen']
spawn(['which', 'pool-one-ab12cd34'])
spawn(['git', 'status', '--porcelain'])
spawn(['pdftoppm', '-v'])
for argv, options in [
    (['which', 'hermes'], {}),
    (['which'], {}),
    (['which', 'pool-one-ab12cd34', 'hermes'], {}),
    (['/usr/bin/which', 'pool-one-ab12cd34'], {}),
    (['which', 'pool-one-Ab12cd34'], {}),
    (['which', 'pool-one-ab12cd34'], {'shell': True}),
    (['which', 'pool-one-ab12cd34'], {'executable': '/bin/sh'}),
    (['sh', '-c', 'true'], {}),
    ('which pool-one-ab12cd34', {}),
    (['git', 'fetch'], {}),
    (['git', 'clone', 'https://example.invalid/synthetic'], {}),
]:
    try:
        spawn(argv, **options)
    except AssertionError:
        continue
    raise AssertionError('Fixture allowed an unrelated subprocess')
`], { encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
});

"""Real Team bridge + clean pinned Hermes profile/learning functions; no inference.

HERMES_SOURCE=/path/to/pinned/hermes python tests/fixtures/hermes-team-pinned-bridge.py
This is source/filesystem evidence, not an official-image Docker lifecycle test.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ['HERMES_SOURCE']).resolve()
MANIFEST = json.loads(Path(__file__).with_name('hermes-team-source-contract.json').read_text())
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != MANIFEST['revision']:
    raise RuntimeError('Use the exact pinned Hermes source')
if subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain', '--untracked-files=all'], text=True).strip():
    raise RuntimeError('Use a clean pinned Hermes source checkout')
for filename, expected in MANIFEST['sourceHashes'].items():
    if hashlib.sha256((SOURCE / filename).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Pinned source changed: {filename}')

BOOT = tempfile.TemporaryDirectory(prefix='cui-team-pinned-boot-')
os.environ.clear()
os.environ.update(PATH='/usr/bin:/bin', HOME=BOOT.name, HERMES_HOME=BOOT.name,
                  HERMES_DISABLE_LAZY_INSTALLS='1', HERMES_LAZY_INSTALL_TARGET='', PYTHONDONTWRITEBYTECODE='1')
sys.path.insert(0, str(SOURCE))
spec = importlib.util.spec_from_file_location('team_pinned_bridge', Path(__file__).parents[2] / 'src/docker-hermes/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
os.environ.update(HERMES_HOME=BOOT.name)
# The production bridge inserts its container source location; keep this fixture's verified checkout first.
sys.path.insert(0, str(SOURCE))
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_cli import profiles, auth
from tools import skill_manager_tool as skills, memory_tool as memory

NAME = 'cui-team-' + 'a' * 32
OTHER = 'cui-team-' + 'b' * 32
SKILL = '---\nname: procedure\ndescription: Synthetic Team profile procedure.\n---\n\nUse the reviewed procedure.\n'


@contextlib.contextmanager
def active(home):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


class PinnedTeamBridge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cui-team-pinned-')
        self.root = Path(self.temp.name) / 'volume'
        self.root.mkdir()
        self.image_metadata = Path(self.temp.name) / 'metadata'
        self.image_metadata.mkdir()
        (self.image_metadata / '.hermes_build_sha').write_text(MANIFEST['revision'])
        bridge.ROOT = self.root
        # Git/source hashes above establish native code identity; this only exercises bridge metadata validation.
        bridge.SOURCE = self.image_metadata
        os.environ.update(HERMES_HOME=str(self.root), HOME=str(Path(self.temp.name) / 'home'))
        (self.root / 'SOUL.md').write_text('Personal root role')
        (self.root / 'config.yaml').write_text('model:\n  provider: company\n  api_key: synthetic-company-key\n')
        (self.root / '.env').write_text('OPENAI_API_KEY=synthetic-company-key\n')
        (self.root / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [{'id': 'root', 'access_token': 'synthetic-root-grant'}]}}))
        (self.root / 'skills/private').mkdir(parents=True)
        (self.root / 'skills/private/SKILL.md').write_text(SKILL)
        (self.root / 'memories').mkdir()
        (self.root / 'memories/MEMORY.md').write_text('Private root memory')
        self.network = [patch.object(socket.socket, 'connect', side_effect=AssertionError('Network is forbidden')),
                        patch.object(socket.socket, 'connect_ex', side_effect=AssertionError('Network is forbidden')),
                        patch.object(socket, 'create_connection', side_effect=AssertionError('Network is forbidden'))]
        for guard in self.network:
            guard.start()

    def tearDown(self):
        for guard in reversed(self.network):
            guard.stop()
        self.temp.cleanup()

    def create(self, name=NAME):
        return bridge.create_team(name), self.root / 'profiles' / name

    def test_blank_creation_uses_the_native_profile_identity_and_never_seeds_root_state(self):
        before = {filename: (self.root / filename).read_bytes() for filename in ('config.yaml', '.env', 'auth.json', 'SOUL.md')}
        first, home = self.create()
        self.assertEqual(bridge.create_team(NAME), first)
        self.assertEqual(profiles.get_profile_dir(NAME), home)
        self.assertEqual(profiles.list_profile_names(), ['default', NAME])
        self.assertEqual(bridge.profiles(), [{'name': 'default', 'identity': bridge.profile('default')[1]}, first])
        self.assertEqual((home / 'config.yaml').read_text(), '{}\n')
        self.assertEqual((home / '.env').read_text(), '')
        self.assertEqual((home / 'auth.json').read_text(), '{}\n')
        self.assertEqual(list((home / 'skills').iterdir()), [])
        self.assertEqual(list((home / 'memories').iterdir()), [])
        self.assertTrue((home / profiles.NO_BUNDLED_SKILLS_MARKER).is_file())
        self.assertTrue((home / 'gateway.parked').is_file())
        for item in home.rglob('*'):
            self.assertEqual(item.stat().st_mode & 0o077, 0)
            if item.is_file():
                self.assertNotIn(b'synthetic-company-key', item.read_bytes())
                self.assertNotIn(b'synthetic-root-grant', item.read_bytes())
        self.assertEqual({filename: (self.root / filename).read_bytes() for filename in before}, before)

    def test_native_gateway_enumeration_parks_team_profiles_and_bridge_denies_direct_inference(self):
        created, home = self.create()
        self.assertEqual(profiles.profiles_to_serve(True), [('default', self.root)])
        self.assertEqual(profiles.profiles_to_serve(True, include_parked=True), [('default', self.root), (NAME, home)])
        with active(home):
            # Native single-profile gateway launch bypasses multiplex parking, so the bridge must independently deny it.
            self.assertEqual(profiles.profiles_to_serve(False), [(NAME, home)])
        with patch.object(sys, 'argv', ['bridge.py', 'gateway', NAME, created['identity']]):
            with self.assertRaisesRegex(ValueError, 'Team inference route is unverified'):
                bridge.main()
        self.assertFalse((home / '.collectiveui-native.lock').exists())
        self.assertFalse((home / 'state.db').exists())

    def test_native_learning_writes_to_each_blank_team_profile_without_copying_sibling_resources(self):
        first, admin = self.create()
        _, member = self.create(OTHER)
        for home in (admin, member):
            with active(home):
                self.assertTrue(json.loads(skills.skill_manage('create', 'procedure', content=SKILL))['success'])
                self.assertTrue(json.loads(skills.skill_manage('write_file', 'procedure', file_path='scripts/check.py',
                                                              file_content='raise RuntimeError("never execute published scripts")'))['success'])
                self.assertTrue(json.loads(skills.skill_manage('patch', 'procedure', old_string='Use the reviewed procedure.',
                                                              new_string=f'Use private correction for {home.name}.'))['success'])
                store = memory.MemoryStore()
                store.load_from_disk()
                self.assertTrue(json.loads(memory.memory_tool('add', content=f'Private memory for {home.name}', store=store))['success'])
            self.assertIn(home.name, (home / 'skills/procedure/SKILL.md').read_text())
            self.assertIn(home.name, (home / 'memories/MEMORY.md').read_text())
        self.assertEqual(bridge.create_team(NAME), first)
        self.assertEqual((self.root / 'skills/private/SKILL.md').read_text(), SKILL)
        self.assertEqual((self.root / 'memories/MEMORY.md').read_text(), 'Private root memory')
        self.assertFalse((self.root / 'skills/procedure').exists())

    def test_root_auth_can_still_be_inherited_so_a_blank_auth_file_does_not_establish_personal_required(self):
        _, home = self.create()
        with active(home):
            borrowed = auth.read_credential_pool('openai-codex')
        self.assertEqual(borrowed[0]['access_token'], 'synthetic-root-grant')
        # This demonstrates why the disabled gateway admission above is required; no token is used.
        self.assertEqual(json.loads((home / 'auth.json').read_text()), {})

    def test_crash_retry_and_profile_quarantine_survive_native_listing(self):
        native_rename = bridge.os.rename
        with patch.object(bridge.os, 'rename', side_effect=OSError('synthetic interrupted rename')):
            with self.assertRaises(OSError):
                self.create()
        self.assertEqual(profiles.list_profile_names(), ['default'])
        first, home = self.create()
        self.assertEqual(bridge.create_team(NAME), first)
        (home / 'gateway.parked').unlink()
        with self.assertRaises(FileNotFoundError):
            bridge.profile(NAME)
        with self.assertRaises(FileNotFoundError):
            bridge.create_team(NAME)
        self.assertEqual(native_rename, bridge.os.rename)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        BOOT.cleanup()

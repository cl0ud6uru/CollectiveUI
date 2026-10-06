"""Execute the pinned native Team Bot contracts with temporary homes and no network.

HERMES_SOURCE=/path/to/pinned/hermes python tests/fixtures/hermes-team-native-contract.py
This verifies native filesystem learning and route selection, not model inference or
ChatGPT entitlement. Provider constructors are replaced only in routing tests.
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
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(os.environ['HERMES_SOURCE']).resolve()
MANIFEST = json.loads(Path(__file__).with_name('hermes-team-source-contract.json').read_text())
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != MANIFEST['revision']:
    raise RuntimeError('Use the exact pinned Hermes source')
for name, expected in MANIFEST['sourceHashes'].items():
    if hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Pinned native source changed: {name}')

# Set the home before importing modules that cache their initial skills/config home.
BOOT = tempfile.TemporaryDirectory(prefix='cui-team-native-bootstrap-')
os.environ.clear()
os.environ.update(PATH='/usr/bin:/bin', HOME=BOOT.name, HERMES_HOME=BOOT.name,
                  HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1')
sys.path.insert(0, str(SOURCE))
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_cli import profiles, auth
from tools import skill_manager_tool as skills, memory_tool as memory, delegate_tool_config as delegation
from agent import auxiliary_client as auxiliary, background_review
import yaml

spec = importlib.util.spec_from_file_location('team_contract_bridge', Path(__file__).parents[2] / 'src/docker-hermes/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

SKILL = '---\nname: procedure\ndescription: A synthetic procedure for the contract fixture.\n---\n\nDo step one.\n'


@contextlib.contextmanager
def active(home):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


class NativeTeamContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cui-team-native-')
        self.root = Path(self.temp.name)
        os.environ.update(HERMES_HOME=str(self.root), HOME=str(self.root / 'home'))
        bridge.ROOT = self.root
        (self.root / 'SOUL.md').write_text('Root personal role')
        (self.root / 'config.yaml').write_text('model:\n  provider: openai-codex\n  default: fixture-model\n')
        self.network = [patch.object(socket.socket, 'connect', side_effect=AssertionError('Network is forbidden')),
                        patch.object(socket, 'create_connection', side_effect=AssertionError('Network is forbidden'))]
        for p in self.network:
            p.start()

    def tearDown(self):
        for p in reversed(self.network):
            p.stop()
        self.temp.cleanup()

    def create(self, name):
        # No supervisor/gateway startup in a filesystem contract test.
        with patch.object(profiles, '_maybe_register_gateway_service'), patch.object(profiles, '_notify_multiplexer'):
            return profiles.create_profile(name, no_alias=True, no_skills=True)

    def test_fresh_no_skills_profile_does_not_copy_private_state_but_seeds_the_model_route(self):
        cfg = {'model': {'provider': 'team-gateway', 'default': 'fixture-model', 'api_key': 'synthetic-inline-secret'},
               'providers': {'team-gateway': {'base_url': 'https://fixture.invalid/v1', 'api_key': 'synthetic-provider-secret'}},
               'auxiliary': {'compression': {'provider': 'anthropic'}}, 'fallback_providers': [{'provider': 'anthropic'}]}
        (self.root / 'config.yaml').write_text(yaml.safe_dump(cfg))
        (self.root / '.env').write_text('OPENAI_API_KEY=synthetic-root-secret\n')
        (self.root / 'auth.json').write_text('{"private":"synthetic-auth"}')
        (self.root / 'memories').mkdir()
        (self.root / 'memories/MEMORY.md').write_text('Private root fact')
        (self.root / 'skills/private').mkdir(parents=True)
        (self.root / 'skills/private/SKILL.md').write_text(SKILL)
        home = self.create('member')
        saved = yaml.safe_load((home / 'config.yaml').read_text())
        saved.pop('_config_version', None)
        self.assertEqual(saved, profiles.launch_model_seed(cfg))
        self.assertNotIn('synthetic-root-secret', (home / '.env').read_text())
        self.assertEqual((home / '.env').stat().st_mode & 0o777, 0o600)
        self.assertFalse((home / 'auth.json').exists())
        self.assertFalse((home / 'memories/MEMORY.md').exists())
        self.assertEqual(list((home / 'skills').iterdir()), [])
        self.assertTrue((home / profiles.NO_BUNDLED_SKILLS_MARKER).is_file())

    def test_profile_directory_identity_survives_resource_changes_and_reopen(self):
        home = self.create('member')
        before = bridge.profile('member')[1]
        (home / 'SOUL.md').write_text('Updated team role')
        (home / 'memories/MEMORY.md').write_text('Private learned fact')
        self.assertEqual(bridge.profile('member')[1], before)
        self.assertEqual(profiles.get_profile_dir('member'), home)
        with self.assertRaises(FileExistsError):
            self.create('member')
        self.assertEqual(bridge.profile('member')[1], before)

    def test_profile_selection_rejects_paths_and_symlink_binding(self):
        home = self.create('member')
        for name in ('../member', '/tmp/member', 'member/other'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                bridge.profile(name)
        (home.parent / 'linked').symlink_to(home)
        with self.assertRaises((ValueError, OSError)):
            bridge.profile('linked')

    def test_admin_and_member_native_learning_preserves_complete_skill_packages(self):
        admin, member = self.create('admin-working'), self.create('member')
        for home in (admin, member):
            with active(home):
                self.assertTrue(json.loads(skills.skill_manage('create', 'procedure', content=SKILL))['success'])
                self.assertTrue(json.loads(skills.skill_manage('write_file', 'procedure', file_path='scripts/check.py',
                                                              file_content='raise RuntimeError("must never execute")'))['success'])
                self.assertTrue(json.loads(skills.skill_manage('write_file', 'procedure', file_path='assets/example.txt',
                                                              file_content=home.name))['success'])
                self.assertTrue(json.loads(skills.skill_manage('patch', 'procedure', old_string='Do step one.',
                                                              new_string=f'Do corrected {home.name} step.'))['success'])
                store = memory.MemoryStore()
                store.load_from_disk()
                self.assertTrue(json.loads(memory.memory_tool('add', content=f'Private fact for {home.name}', store=store))['success'])
        for home in (admin, member):
            self.assertIn(f'Do corrected {home.name} step.', (home / 'skills/procedure/SKILL.md').read_text())
            self.assertEqual((home / 'skills/procedure/assets/example.txt').read_text(), home.name)
            self.assertIn('must never execute', (home / 'skills/procedure/scripts/check.py').read_text())
            self.assertIn(f'Private fact for {home.name}', (home / 'memories/MEMORY.md').read_text())
        self.assertFalse((self.root / 'skills/procedure').exists())

    def test_member_skill_creation_cannot_resolve_the_admin_skill(self):
        admin, member = self.create('admin-working'), self.create('member')
        with active(admin):
            self.assertTrue(json.loads(skills.skill_manage('create', 'procedure', content=SKILL))['success'])
        with active(member):
            self.assertIsNone(skills._find_skill('procedure'))
            self.assertFalse(json.loads(skills.skill_manage('patch', 'procedure', old_string='Do step one.', new_string='Private correction'))['success'])
        self.assertEqual((admin / 'skills/procedure/SKILL.md').read_text(), SKILL)

    def test_native_memory_writes_persist_immediately_and_the_next_session_refreshes_its_snapshot(self):
        home = self.create('member')
        with active(home):
            first = memory.MemoryStore()
            first.load_from_disk()
            self.assertIsNone(first.format_for_system_prompt('memory'))
            self.assertTrue(json.loads(memory.memory_tool('add', content='Use the corrected procedure.', store=first))['success'])
            self.assertIn('Use the corrected procedure.', (home / 'memories/MEMORY.md').read_text())
            self.assertIsNone(first.format_for_system_prompt('memory'))
            reopened = memory.MemoryStore()
            reopened.load_from_disk()
            self.assertIn('Use the corrected procedure.', reopened.format_for_system_prompt('memory'))

    def test_native_config_clone_copies_skills_and_memory_so_it_is_not_a_publication_boundary(self):
        source = self.create('admin-working')
        (source / 'memories/MEMORY.md').write_text('Shared working memory, not publishable')
        (source / 'skills/procedure').mkdir()
        (source / 'skills/procedure/SKILL.md').write_text(SKILL)
        with patch.object(profiles, '_maybe_register_gateway_service'), patch.object(profiles, '_notify_multiplexer'):
            copied = profiles.create_profile('cloned-member', clone_from='admin-working', clone_config=True, no_alias=True)
        self.assertEqual((copied / 'skills/procedure/SKILL.md').read_text(), SKILL)
        self.assertEqual((copied / 'memories/MEMORY.md').read_text(), 'Shared working memory, not publishable')

    def test_empty_profile_pool_and_dotenv_do_not_disable_root_credential_inheritance(self):
        home = self.create('member')
        root_row = {'id': 'root-grant', 'access_token': 'synthetic-root-grant', 'source': 'hermes'}
        personal_row = {'id': 'personal-grant', 'access_token': 'synthetic-personal-grant', 'source': 'hermes'}
        (self.root / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [root_row]}}))
        for profile_pool, expected in (({}, [root_row]), ({'openai-codex': []}, [root_row]),
                                       ({'openai-codex': [personal_row]}, [personal_row])):
            (home / 'auth.json').write_text(json.dumps({'credential_pool': profile_pool}))
            with active(home):
                self.assertEqual(auth.read_credential_pool('openai-codex'), expected)

    def test_selected_personal_main_route_does_not_discover_other_accounts_when_unavailable(self):
        for task in ('compression', 'title_generation', 'session_search', 'vision', 'web_extract', 'curator'):
            with (self.subTest(task=task),
                  patch.object(auxiliary, '_main_route_target', return_value=('openai-codex', 'fixture-model', '', '', '')),
                  patch.object(auxiliary, '_try_main_provider_route', return_value=None),
                  patch.object(auxiliary, '_try_configured_fallback_chain', return_value=(None, None, '')),
                  patch.object(auxiliary, '_try_main_fallback_chain', return_value=(None, None, '')),
                  patch.object(auxiliary, '_try_discovery_chain') as discovery):
                self.assertEqual(auxiliary._resolve_auto_route({'provider': 'openai-codex'}, task), (None, None, ''))
                discovery.assert_not_called()

    def test_auto_and_explicit_fallback_configuration_can_select_a_company_route(self):
        sentinel = object()
        with (patch.object(auxiliary, '_main_route_target', return_value=('openai-codex', 'fixture-model', '', '', '')),
              patch.object(auxiliary, '_try_main_provider_route', return_value=None),
              patch.object(auxiliary, '_get_auxiliary_task_config', return_value={'fallback_chain': [{'provider': 'openai-api', 'model': 'company-model'}]}),
              patch.object(auxiliary, '_resolve_fallback_entry', return_value=(sentinel, 'company-model')),
              patch.object(auxiliary, '_is_provider_unhealthy', return_value=False)):
            client, model, _ = auxiliary._resolve_auto_route({'provider': 'openai-codex'}, 'title_generation')
            self.assertIs(client, sentinel)
            self.assertEqual(model, 'company-model')

    def test_capacity_failure_does_not_discover_company_accounts_for_selected_personal_main(self):
        with patch.object(auxiliary, '_get_provider_chain') as discovery:
            self.assertEqual(auxiliary._try_payment_fallback('openai-codex', 'compression',
                             main_runtime={'provider': 'openai-codex', 'model': 'fixture-model'}), (None, None, ''))
            discovery.assert_not_called()

    def test_delegated_children_inherit_parent_fallback_unless_explicitly_cleared(self):
        parent = SimpleNamespace(_fallback_chain=[{'provider': 'openai-api', 'model': 'company-model'}])
        self.assertEqual(delegation._resolve_child_fallback_chain(parent, {}, pinned=False), parent._fallback_chain)
        self.assertFalse(delegation._resolve_child_fallback_chain(parent, {'fallback_providers': []}, pinned=False))
        self.assertFalse(delegation._resolve_child_fallback_chain(parent, {}, pinned=True))

    def test_native_background_learning_uses_parent_or_its_own_override_route(self):
        parent = SimpleNamespace(provider='openai-codex', model='personal-model',
                                 _current_main_runtime=lambda: {'api_key': 'synthetic-personal', 'base_url': 'https://chatgpt.com/backend-api/codex',
                                                               'api_mode': 'codex_responses'})
        inherited = background_review._resolve_review_runtime(parent, {'provider': 'auto'})
        self.assertEqual(inherited['provider'], 'openai-codex')
        self.assertEqual(inherited['model'], 'personal-model')
        self.assertFalse(inherited['routed'])
        with patch('hermes_cli.runtime_provider.resolve_runtime_provider', return_value={'provider': 'openai-api', 'model': 'company-model'}) as resolve:
            overridden = background_review._resolve_review_runtime(parent, {'provider': 'openai-api', 'model': 'company-model'})
        self.assertTrue(overridden['routed'])
        self.assertEqual(overridden['provider'], 'openai-api')
        resolve.assert_called_once()
        parent.provider, parent.model = 'openai-api', 'company-model'
        with patch('hermes_cli.runtime_provider.resolve_runtime_provider', side_effect=RuntimeError('synthetic personal grant expired')):
            fallback = background_review._resolve_review_runtime(parent, {'provider': 'openai-codex', 'model': 'personal-model'})
        self.assertEqual(fallback['provider'], 'openai-api')
        self.assertFalse(fallback['routed'])

    def test_pinned_codex_is_the_native_codex_route(self):
        from providers import get_provider_profile
        route = get_provider_profile('openai-codex')
        self.assertEqual(route.base_url, 'https://chatgpt.com/backend-api/codex')
        self.assertEqual(route.api_mode, 'codex_responses')
        self.assertEqual(route.auth_type, 'oauth_external')
        self.assertEqual(bridge.CODEX, 'openai-codex')
        self.assertFalse(MANIFEST['modelAccess']['officialChatgptPlanUsageVerified'])
        self.assertEqual(MANIFEST['modelAccess']['enabledTeamRoutes'], [])


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        BOOT.cleanup()

"""Pinned native config + mocked HTTP checks. No credentials or inference outside this fixture.
HERMES_SOURCE=/path/to/pinned/hermes python tests/fixtures/docker-hermes-settings.py
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ['HERMES_SOURCE'])
COMMIT = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'
source_revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() if shutil.which('git') else (SOURCE / '.hermes_build_sha').read_text().strip()
if source_revision != COMMIT:
    raise RuntimeError('Use the exact pinned Hermes source')
sys.path.insert(0, str(SOURCE))
spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[2] / 'src/docker-hermes/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
import yaml
import httpx


def key(provider, suffix='first'):
    return ('sk-ant-api03-' if provider == 'anthropic' else 'sk-or-v1-' if provider == 'openrouter' else 'sk-') + 'fixture-not-real-' + suffix + 'abcdefghijklmnopqrstuvwxyz0123456789'


class NativeSettings(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cui-settings-native-')
        self.root = Path(self.temp.name)
        self.environment = dict(os.environ)
        os.environ.update(HERMES_HOME=str(self.root), HOME=str(self.root / 'home'), HERMES_DISABLE_LAZY_INSTALLS='1')
        bridge.ROOT = self.root
        self.seed(self.root)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.environment)
        self.temp.cleanup()

    def seed(self, home):
        home.mkdir(parents=True, exist_ok=True)
        (home / 'SOUL.md').write_text('Native fixture')
        (home / 'config.yaml').write_text('model: {}\nterminal:\n  backend: local\ncustom_prompt: Keep this native setting\n')

    def files(self, home=None):
        with bridge.directory_fd(home or self.root) as fd:
            return bridge.snapshot(fd)

    def data(self, files, provider='openai-api', action='replace', suffix='first'):
        return {'revision': bridge.settings_revision(files), 'provider': provider, 'model': 'fixture-model',
                'reasoningEffort': 'low', 'maxTurns': 12,
                'credential': {'action': action, **({'value': key(provider, suffix)} if action == 'replace' else {})}}

    def save(self, data, name='default'):
        return bridge.profile_settings(name, bridge.profile(name)[1], 'settings-save', data)

    def test_pinned_image_seed_can_select_every_supported_provider(self):
        # s6 copies these exact files on first boot; an empty model fixture missed this route.
        (self.root / 'config.yaml').write_text((SOURCE / 'cli-config.yaml.example').read_text())
        (self.root / '.env').write_text((SOURCE / '.env.example').read_text())
        before = self.files()
        view = bridge.settings_view(before)
        self.assertIsNone(view['provider'])
        self.assertEqual(view['model'], 'anthropic/claude-opus-4.6')
        self.assertTrue(view['advancedSupported'])
        self.assertTrue(all(view['editableProviders'].values()), view['editableProviders'])
        self.assertEqual(before, self.files())

    def test_custom_and_imported_routes_stay_blocked_without_disclosing_values(self):
        cases = [
            ({'model': {'provider': 'auto', 'base_url': 'https://secret-endpoint.invalid'}}, {}, {}, 'custom_endpoint'),
            ({'model': {'provider': 'openai-codex', 'base_url': bridge.PROVIDERS['openrouter'][1]}}, {}, {}, 'custom_endpoint'),
            ({'model': {'api_key': 'private-inline-value'}}, {}, {}, 'model_authentication'),
            ({'model': {'key_env': 'PRIVATE_KEY_NAME'}}, {}, {}, 'model_authentication'),
            ({'model': {'api_mode': 'custom'}}, {}, {}, 'model_authentication'),
            ({'model': {'openai_runtime': 'codex_app_server'}}, {}, {}, 'codex_runtime'),
            ({}, {'HERMES_CODEX_BASE_URL': 'https://secret-endpoint.invalid'}, {}, 'custom_endpoint'),
            ({'providers': {'openai-codex': {'custom': 'private-value'}}}, {}, {}, 'provider_configuration'),
            ({'custom_providers': [{'name': 'openai-codex', 'api_key': 'private-value'}]}, {}, {}, 'custom_provider'),
            ({}, {}, {'credential_pool': {'openai-codex': [{'source': 'manual:private-value'}]}}, 'credential_pool'),
        ]
        for cfg, env, auth, reason in cases:
            with self.subTest(reason=reason, cfg=cfg):
                self.assertFalse(bridge.simple_route(cfg, env, auth, 'openai-codex'))
                self.assertEqual(bridge.route_blocker(cfg, env, auth, 'openai-codex'), reason)
        files = self.files()
        files['config.yaml'] = 'model:\n  base_url: https://secret-endpoint.invalid\n'
        files['auth.json'] = json.dumps({'credential_pool': {'openai-codex': [{'source': 'manual:private-value'}]}})
        view = bridge.settings_view(files)
        self.assertEqual(view['providerBlockers']['openai-codex'], 'custom_endpoint')
        self.assertNotIn('secret-endpoint', json.dumps(view))
        self.assertNotIn('private-value', json.dumps(view))

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(), 'Native transaction requires Linux /proc')
    def test_image_seed_transitions_preserve_unrelated_native_settings(self):
        for provider in bridge.SUPPORTED_PROVIDERS:
            with self.subTest(provider=provider):
                (self.root / 'config.yaml').write_text((SOURCE / 'cli-config.yaml.example').read_text())
                (self.root / '.env').write_text('UNRELATED_FIXTURE_VALUE=keep-me\n')
                before_cfg = bridge.parse_settings(self.files())[0]
                saved = self.save(self.data(self.files(), provider, action='keep' if provider == bridge.CODEX else 'replace'))
                self.assertEqual(saved['provider'], provider)
                self.assertTrue(saved['editableProviders'][provider])
                cfg, env, _ = bridge.parse_settings(self.files())
                self.assertNotIn('base_url', cfg['model'])
                self.assertEqual(env['UNRELATED_FIXTURE_VALUE'], 'keep-me')
                for name in before_cfg.keys() - {'model', 'providers', 'agent'}:
                    self.assertEqual(cfg[name], before_cfg[name], name)

    def test_all_providers_roundtrip_rotate_clear_readd_without_secret_response(self):
        for provider in bridge.PROVIDERS:
            with self.subTest(provider=provider):
                response = self.save(self.data(self.files(), provider))
                self.assertTrue(response['credentials'][provider])
                self.assertNotIn(key(provider), json.dumps(response))
                cfg, env, auth = bridge.parse_settings(self.files())
                self.assertEqual(cfg['custom_prompt'], 'Keep this native setting')
                self.assertEqual(cfg['terminal'], {'backend': 'local'})
                self.assertEqual(cfg['agent']['max_turns'], 12)
                self.assertEqual(cfg['model']['provider'], provider)
                self.save(self.data(self.files(), provider, suffix='rotated'))
                self.assertNotIn(key(provider), json.dumps(self.files()))
                response = self.save(self.data(self.files(), provider, action='clear'))
                cfg, env, auth = bridge.parse_settings(self.files())
                self.assertFalse(response['credentials'][provider])
                self.assertFalse(cfg['providers'][provider]['enabled'])
                self.assertNotIn(key(provider, 'rotated'), json.dumps(self.files()))
                self.save(self.data(self.files(), provider, suffix='readded'))
                self.assertTrue(bridge.parse_settings(self.files())[0]['providers'][provider]['enabled'])

    def test_named_profile_never_rotates_or_clears_default_credential(self):
        self.save(self.data(self.files()))
        before = self.files()
        named = self.root / 'profiles' / 'coder'
        self.seed(named)
        self.save(self.data(self.files(named), suffix='named'), 'coder')
        self.assertEqual(self.files(), before)
        self.save(self.data(self.files(named), action='clear'), 'coder')
        self.assertEqual(self.files(), before)
        # Native resolution must refuse the disabled provider instead of inheriting root auth.
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from hermes_cli.runtime_provider import resolve_runtime_provider
        token = set_hermes_home_override(str(named))
        try:
            with self.assertRaisesRegex(ValueError, 'disabled'):
                resolve_runtime_provider(requested='openai-api', target_model='fixture-model')
        finally:
            reset_hermes_home_override(token)

    def test_stock_provider_switch_matrix_preserves_credentials_and_unrelated_settings(self):
        for provider in bridge.PROVIDERS:
            self.save(self.data(self.files(), provider))
        with bridge.directory_fd(self.root) as fd:
            bridge.change_codex_auth(fd, {'access_token': 'synthetic-matrix-access', 'refresh_token': 'synthetic-matrix-refresh'})
        original = self.files()
        for source in bridge.SUPPORTED_PROVIDERS:
            for target in bridge.SUPPORTED_PROVIDERS:
                with self.subTest(source=source, target=target):
                    with bridge.directory_fd(self.root) as fd: bridge.restore_settings(fd, original)
                    cfg = yaml.safe_load(original['config.yaml'])
                    endpoint, mode = bridge.stock_route(source)
                    cfg['model'].update(provider=source, base_url=endpoint, api_mode=mode, openai_runtime='auto', context_length=32768)
                    (self.root / 'config.yaml').write_text(yaml.safe_dump(cfg))
                    before = self.files()
                    self.assertTrue(bridge.settings_view(before)['editableProviders'][target])
                    response = self.save(self.data(before, target, action='keep'))
                    self.assertNotIn('error', response)
                    after = self.files()
                    model = yaml.safe_load(after['config.yaml'])['model']
                    self.assertEqual(model['provider'], target)
                    self.assertEqual(model['context_length'], 32768)
                    self.assertEqual(model['openai_runtime'], 'auto')
                    if source == target:
                        self.assertEqual((model['base_url'], model['api_mode']), (endpoint, mode))
                    else:
                        self.assertNotIn('base_url', model)
                        self.assertNotIn('api_mode', model)
                    self.assertEqual(after['.env'], before['.env'])
                    self.assertEqual(after['auth.json'], before['auth.json'])
                    self.assertEqual(yaml.safe_load(after['config.yaml'])['custom_prompt'], 'Keep this native setting')
                    for secret in [key(p) for p in bridge.PROVIDERS] + ['synthetic-matrix-access', 'synthetic-matrix-refresh']:
                        self.assertNotIn(secret, json.dumps(response))

    def test_auto_runtime_and_equivalent_stock_endpoint_allow_explicit_switch(self):
        for runtime in (None, '', 'auto', ' AUTO '):
            with self.subTest(runtime=runtime):
                cfg = {'model': {'provider': 'openai-api', 'base_url': 'https://API.OPENAI.COM:443/v1/',
                                 'api_mode': 'codex_responses', 'openai_runtime': runtime}}
                (self.root / 'config.yaml').write_text(yaml.safe_dump(cfg))
                response = self.save(self.data(self.files(), 'openai-codex', action='keep'))
                self.assertNotIn('error', response)

    def test_custom_routes_pointers_aliases_and_mixed_pools_remain_untouched(self):
        baseline = self.files()
        cases = [({'model': {'provider': 'openai-api', **addition}}, {}, {}) for addition in (
            {'base_url': 'https://api.openai.com/v1/custom'}, {'base_url': 'https://api.openai.com/v1?tenant=1'},
            {'base_url': 'https://user@api.openai.com/v1'}, {'api_mode': 'chat_completions'},
            {'key_env': 'CUSTOM_KEY'}, {'api_key_env': 'CUSTOM_KEY'}, {'api_key': 'synthetic-inline'},
            {'api': 'synthetic-inline'}, {'openai_runtime': 'codex_app_server'}, {'openai_runtime': 'unknown'},
            {'api_base': 'https://custom.invalid'},
        )]
        cases += [({'model': {'provider': 'openai-api'}, field: value}, {}, {}) for field, value in (
            ('base_url', 'https://custom.invalid'), ('api_base', 'https://custom.invalid'), ('provider', 'openai'),
        )]
        cases += [({'model': {'provider': 'openai'}}, {}, {})]
        for provider in ('openai-api', 'openai-codex'):
            source = 'device_code' if provider == 'openai-codex' else 'env:OPENAI_API_KEY'
            cases += [({'model': {'provider': 'openai-api'}}, {}, {'credential_pool': {provider: [entry]}}) for entry in (
                {'source': 'manual:imported', 'access_token': 'synthetic-imported'},
                {'source': source, 'base_url': 'https://custom.invalid', 'access_token': 'synthetic-custom'},
            )]
        cases += [({'model': {'provider': 'openai-api'}}, {'OPENAI_BASE_URL': 'https://custom.invalid'}, {}),
                  ({'model': {'provider': 'openai-api'}}, {}, {'providers': {'openai-api': {'tokens': {'access_token': 'synthetic-imported'}}}})]
        for cfg, env, auth in cases:
            with self.subTest(config=cfg, env_keys=list(env), auth_providers=list(auth)):
                with bridge.directory_fd(self.root) as fd: bridge.restore_settings(fd, baseline)
                (self.root / 'config.yaml').write_text(yaml.safe_dump(cfg))
                (self.root / '.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items()))
                (self.root / 'auth.json').write_text(json.dumps(auth))
                before = self.files()
                self.assertFalse(bridge.settings_view(before)['editableProviders']['openai-codex'])
                self.assertEqual(self.save(self.data(before, 'openai-codex', action='keep')), {'error': 'unsupported'})
                self.assertEqual(self.files(), before)

    def test_openrouter_switch_keeps_stock_openai_env_but_protects_custom_override(self):
        self.save(self.data(self.files(), 'openai-api'))
        with (self.root / '.env').open('a') as f: f.write('\nOPENAI_BASE_URL=https://api.openai.com/v1\n')
        response = self.save(self.data(self.files(), 'openrouter'))
        self.assertNotIn('error', response)
        with (self.root / '.env').open('a') as f: f.write('\nCUSTOM_BASE_URL=https://custom.invalid\n')
        before = self.files()
        self.assertEqual(self.save(self.data(before, 'openai-codex', action='keep')), {'error': 'unsupported'})
        self.assertEqual(self.files(), before)

    def test_stale_revision_and_identity_cannot_write(self):
        before = self.files(); data = self.data(before)
        self.save(data)
        saved = self.files()
        self.assertEqual(self.save(data), {'error': 'conflict'})
        self.assertEqual(self.files(), saved)
        with self.assertRaisesRegex(ValueError, 'identity'):
            bridge.profile_settings('default', 'replaced', 'settings-save', self.data(saved))

    def test_symlink_hardlink_and_fifo_are_rejected(self):
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                destination = self.root / '.env'
                target = self.root / 'other'; target.write_text('Fixture only')
                if kind == 'symlink': destination.symlink_to(target)
                elif kind == 'hardlink': os.link(target, destination)
                else: os.mkfifo(destination)
                with self.assertRaises((ValueError, OSError)):
                    self.save(self.data({'config.yaml': '{}', '.env': None, 'auth.json': None, 'provider_models_cache.json': None}))
                destination.unlink(); target.unlink()

    def test_failed_commit_rolls_back_every_native_file(self):
        before = self.files(); actual = bridge.atomic_at
        failed = False
        def fail_once(fd, name, value):
            nonlocal failed
            if name == '.env' and not failed:
                failed = True
                raise OSError('Synthetic disk failure')
            return actual(fd, name, value)
        with patch.object(bridge, 'atomic_at', side_effect=fail_once):
            with self.assertRaises(OSError): self.save(self.data(before))
        self.assertEqual(self.files(), before)
        self.assertFalse((self.root / bridge.JOURNAL).exists())

    def test_interrupted_transaction_recovers_before_admission(self):
        before = self.files()
        stage = self.root / bridge.STAGE
        stage.mkdir(mode=0o700)
        (stage / '.env').write_text('OPENAI_API_KEY=interrupted-stage-copy')
        (self.root / bridge.JOURNAL).write_text(json.dumps(before))
        (self.root / '.env').write_text('OPENAI_API_KEY=interrupted-fixture')
        with self.assertRaisesRegex(ValueError, 'recovery'):
            bridge.profile_settings('default', bridge.profile('default')[1], 'settings-read')
        with bridge.directory_fd(self.root) as fd:
            bridge.recover_settings(fd)
        self.assertEqual(self.files(), before)
        self.assertFalse(stage.exists())

    def test_orphan_atomic_write_is_removed_before_recovery_even_without_journal(self):
        # A killed writer before its first rename may leave only the reserved temporary file.
        before = self.files()
        (self.root / bridge.SETTINGS_TEMP).write_text('synthetic-key-from-interrupted-rename')
        with bridge.directory_fd(self.root) as fd:
            bridge.recover_settings(fd)
        self.assertEqual(self.files(), before)
        self.assertFalse((self.root / bridge.SETTINGS_TEMP).exists())

    def test_rejects_mixed_native_auth_and_unsupported_inputs(self):
        before = self.files()
        data = self.data(before)
        data['shell'] = 'anything'
        with self.assertRaises(ValueError): self.save(data)
        data = self.data(before); data['credential']['value'] = 'bad\nAPI_KEY=injection'
        with self.assertRaises(ValueError): self.save(data)
        (self.root / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-api': [{'source': 'manual:other', 'access_token': 'fixture'}]}}))
        before = self.files()
        self.assertEqual(self.save(self.data(before)), {'error': 'unsupported'})
        self.assertEqual(self.files(), before)

    def test_probe_is_one_bounded_request_no_redirect_retry_tools_or_history(self):
        actual_client = httpx.Client
        for provider in bridge.PROVIDERS:
            self.save(self.data(self.files(), provider))
            for status, expected in [(200, 'verified'), (401, 'authentication_failed'), (403, 'connection_failed'), (404, 'model_rejected'), (429, 'connection_failed'), (302, 'connection_failed')]:
                calls = []
                def handler(req):
                    calls.append(req)
                    if status == 200:
                        body = {'id': 'fixture', 'object': 'response', 'type': 'message', 'role': 'assistant', 'content': [{'type': 'text', 'text': 'OK'}], 'model': 'fixture-model', 'output': [], 'choices': [{'message': {'role': 'assistant', 'content': 'OK'}}], 'usage': {'input_tokens': 1, 'output_tokens': 1}}
                    else: body = {'error': {'message': 'secret-fixture-must-not-escape'}}
                    return httpx.Response(status, json=body, headers={'location': 'http://169.254.169.254/never-follow'})
                class FixtureClient(actual_client):
                    def __init__(self, **kwargs):
                        super().__init__(**kwargs, transport=httpx.MockTransport(handler))
                with patch.object(httpx, 'Client', FixtureClient):
                    self.assertEqual(bridge.test_settings(self.files()), expected, (provider, status))
                self.assertEqual(len(calls), 1)
                body = json.loads(calls[0].content)
                self.assertEqual(body['model'], 'fixture-model')
                self.assertNotIn('tools', body)
                self.assertIn(str(calls[0].url).split('/')[2], ['api.openai.com', 'api.anthropic.com', 'openrouter.ai'])
                self.assertLessEqual(body.get('max_tokens', body.get('max_output_tokens')), 16)


if __name__ == '__main__':
    unittest.main(verbosity=2)

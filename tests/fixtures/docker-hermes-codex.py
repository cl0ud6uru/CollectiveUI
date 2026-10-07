"""Pinned native OAuth with synthetic tokens and mocked HTTP only; never signs in."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location('settings_fixture', Path(__file__).with_name('docker-hermes-settings.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
bridge, httpx = base.bridge, base.httpx
from hermes_cli.web_routers import oauth
from hermes_cli import auth_codex

TOKENS = {'access_token': 'synthetic-access-not-real', 'refresh_token': 'synthetic-refresh-not-real'}

class NativeCodex(base.NativeSettings):
    # Inherits native transaction/path/identity tests, now also exercises subscription routes.
    def setUp(self):
        super().setUp()
        self.clock = 1800000000.0
        self.requests = []
        self.poll_status = 403
        self.grant = TOKENS
        client = httpx.Client
        def handler(request):
            self.requests.append(request)
            return httpx.Response(self.poll_status, json={'authorization_code': 'synthetic-code', 'code_verifier': 'synthetic-verifier'})
        self.patches = [
            patch.object(bridge.time, 'time', side_effect=lambda: self.clock),
            patch.object(oauth, '_codex_request_user_code', return_value={'user_code': 'ABCD-EFGH', 'device_auth_id': 'synthetic-device', 'interval': 5}),
            patch.object(oauth, '_codex_exchange_tokens', side_effect=lambda *_: self.grant),
            patch.object(auth_codex, '_codex_http_client', side_effect=lambda **kw: client(**kw, transport=httpx.MockTransport(handler))),
        ]
        self.mocks = [p.start() for p in self.patches]
        self.configure()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        super().tearDown()

    def configure(self, name='default'):
        home = self.root if name == 'default' else self.root / 'profiles' / name
        if name != 'default': self.seed(home)
        self.save(self.data(self.files(home), 'openai-codex', action='keep'), name)

    def call(self, action, name='default', **kwargs):
        return bridge.profile_codex(name, bridge.profile(name)[1], {'action': action, **kwargs})

    def start(self, name='default'):
        home = self.root if name == 'default' else self.root / 'profiles' / name
        return self.call('start', name, sessionId=str(uuid4()), revision=bridge.settings_revision(self.files(home)))

    def approve(self, pending, name='default'):
        self.clock += 6; self.poll_status = 200
        return self.call('poll', name, sessionId=pending['sessionId'])

    def test_process_collision_blocks_oauth_poll_before_http_or_grant_write(self):
        pending = self.start()
        self.clock += 6
        before = self.files()
        self.process(self.other_pid, ['hermes'], {'HERMES_HOME': str(self.root)})
        with self.assertRaisesRegex(ValueError, 'already has a native process'):
            self.call('poll', sessionId=pending['sessionId'])
        self.assertEqual(self.files(), before)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.mocks[2].call_count, 0)

    def test_unreadable_process_blocks_oauth_poll_before_http_or_grant_write(self):
        pending = self.start()
        self.clock += 6
        before = self.files()
        record = self.process(self.other_pid, ['hermes'], {'HERMES_HOME': str(self.root)})
        read_bytes = Path.read_bytes
        def denied(path):
            if path == record / 'environ':
                raise PermissionError('Synthetic unreadable process metadata')
            return read_bytes(path)
        with patch.object(Path, 'read_bytes', denied):
            with self.assertRaisesRegex(PermissionError, 'Synthetic unreadable process metadata'):
                self.call('poll', sessionId=pending['sessionId'])
        self.assertEqual(self.files(), before)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.mocks[2].call_count, 0)

    def test_device_poll_is_bounded_and_never_exports_tokens(self):
        pending = self.start()
        self.assertEqual(pending['state'], 'pending')
        self.assertEqual(pending['verificationUrl'], 'https://auth.openai.com/codex/device')
        self.assertNotIn('synthetic-device', json.dumps(pending))
        self.assertEqual((self.root / bridge.CODEX_DEVICE).stat().st_mode & 0o777, 0o600)
        self.call('poll', sessionId=pending['sessionId']); self.assertEqual(len(self.requests), 0)
        self.clock += 6
        self.assertEqual(self.call('poll', sessionId=pending['sessionId'])['state'], 'pending')
        self.assertEqual(len(self.requests), 1)
        connected = self.approve(pending)
        self.assertEqual(connected['state'], 'connected')
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(str(self.requests[0].url), 'https://auth.openai.com/api/accounts/deviceauth/token')
        self.assertTrue(bridge.settings_view(self.files())['credentials']['openai-codex'])
        self.assertIn(TOKENS['refresh_token'], self.files()['auth.json'])
        for value in TOKENS.values(): self.assertNotIn(value, json.dumps(connected))
        self.assertNotIn('ABCD-EFGH', (self.root / bridge.CODEX_DEVICE).read_text())
        self.call('poll', sessionId=pending['sessionId']); self.assertEqual(self.mocks[2].call_count, 1)

    def test_reconnect_cancel_stale_session_and_readd(self):
        self.approve(self.start())
        fresh = self.start()
        self.assertFalse(bridge.settings_view(self.files())['credentials']['openai-codex'])
        before = self.files()
        self.assertEqual(self.call('cancel', sessionId=str(uuid4())), {'error': 'conflict'})
        self.assertEqual(before, self.files())
        self.assertEqual(self.call('cancel', sessionId=fresh['sessionId'])['state'], 'cancelled')
        self.assertEqual(self.approve(fresh)['state'], 'cancelled')
        self.assertEqual(self.approve(self.start())['state'], 'connected')
        self.call('disconnect', revision=bridge.settings_revision(self.files()))
        cfg, _, _ = bridge.parse_settings(self.files())
        self.assertFalse(cfg['providers']['openai-codex']['enabled'])
        self.assertNotIn(TOKENS['refresh_token'], self.files()['auth.json'])

    def test_named_profile_uses_separate_grant_and_disconnect_blocks_inheritance(self):
        self.approve(self.start()); root_before = self.files()
        self.configure('coder'); named = self.root / 'profiles/coder'
        self.grant = {'access_token': 'synthetic-named-access', 'refresh_token': 'synthetic-named-refresh'}
        self.assertEqual(self.approve(self.start('coder'), 'coder')['state'], 'connected')
        self.assertEqual(root_before, self.files())
        self.assertNotIn(TOKENS['refresh_token'], self.files(named)['auth.json'])
        self.call('disconnect', 'coder', revision=bridge.settings_revision(self.files(named)))
        self.assertEqual(root_before, self.files())
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from hermes_cli.runtime_provider import resolve_runtime_provider
        scope = set_hermes_home_override(str(named))
        try:
            with self.assertRaisesRegex(ValueError, 'disabled'):
                resolve_runtime_provider(requested='openai-codex', target_model='fixture-model')
        finally: reset_hermes_home_override(scope)

    def test_expired_and_incomplete_grants_never_commit(self):
        pending = self.start(); self.clock += 901
        self.assertEqual(self.call('poll', sessionId=pending['sessionId'])['state'], 'expired')
        self.assertEqual(len(self.requests), 0)
        self.grant = {'access_token': 'synthetic-without-refresh'}
        self.assertEqual(self.approve(self.start())['state'], 'error')
        self.assertFalse(bridge.settings_view(self.files())['credentials']['openai-codex'])
        self.assertNotIn('synthetic-without-refresh', self.files()['auth.json'])

    def test_interrupted_exchange_never_replays_and_removes_committed_grant(self):
        pending = self.start()
        with bridge.directory_fd(self.root) as fd:
            value = bridge.codex_device(fd); value['state'] = 'exchanging'
            bridge.atomic_at(fd, bridge.CODEX_DEVICE, json.dumps(value))
            bridge.change_codex_auth(fd, TOKENS)  # Simulate interruption after grant commit before receipt.
        self.assertEqual(self.call('poll', sessionId=pending['sessionId'])['state'], 'interrupted')
        self.assertEqual(self.mocks[2].call_count, 0)
        self.assertFalse(bridge.settings_view(self.files())['credentials']['openai-codex'])
        pending = self.start(); self.call('recover')
        self.assertEqual(self.call('poll', sessionId=pending['sessionId'])['state'], 'interrupted')

    def test_broker_unconfirmed_completed_grant_is_removed_only_for_matching_session(self):
        pending = self.start(); self.approve(pending)
        self.call('recover', sessionId=str(uuid4()))
        self.assertTrue(bridge.settings_view(self.files())['credentials']['openai-codex'])
        self.call('recover', sessionId=pending['sessionId'])
        self.assertFalse(bridge.settings_view(self.files())['credentials']['openai-codex'])
        self.assertEqual(self.call('poll', sessionId=pending['sessionId'])['state'], 'interrupted')

    def test_global_deadline_escapes_native_transport_retry(self):
        import signal
        actual_client = httpx.Client
        calls = []
        def handler(request):
            calls.append(request)
            signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
            raise AssertionError('deadline must escape native retry')
        def native_start(module):
            return oauth._codex_post(module, 'https://auth.openai.com/api/accounts/deviceauth/usercode')
        with patch.object(oauth, '_codex_request_user_code', side_effect=native_start), patch.object(oauth, '_codex_client', side_effect=lambda _: actual_client(transport=httpx.MockTransport(handler))):
            self.assertEqual(self.start()['state'], 'error')
        self.assertEqual(len(calls), 1)
        self.assertFalse(bridge.settings_view(self.files())['credentials']['openai-codex'])

    def test_custom_endpoint_app_server_and_mixed_pool_fail_closed(self):
        before = self.files()
        for addition in ('  openai_runtime: codex_app_server\n', '  base_url: https://untrusted.invalid\n'):
            cfg = 'model:\n  provider: openai-codex\n  default: fixture-model\n' + addition
            (self.root / 'config.yaml').write_text(cfg)
            self.assertFalse(bridge.settings_view(self.files())['editableProviders']['openai-codex'])
            self.assertEqual(self.start(), {'error': 'unsupported'})
        with bridge.directory_fd(self.root) as fd: bridge.restore_settings(fd, before)
        (self.root / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [{'source': 'manual:external', 'access_token': 'fixture'}]}}))
        self.assertEqual(self.start(), {'error': 'unsupported'})

if __name__ == '__main__': unittest.main(verbosity=2)

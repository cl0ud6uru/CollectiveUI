"""Fixed-provider DNS/TLS probe tests. Synthetic sockets only; no native auth or inference."""
import importlib.util
from pathlib import Path
import socket
import ssl
import unittest
from unittest.mock import MagicMock, patch
spec = importlib.util.spec_from_file_location('network_bridge', Path(__file__).parents[2] / 'src/docker-hermes/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.signal = patch('signal.signal').start()
        self.alarm = patch('signal.alarm').start()
        self.connect = patch('socket.create_connection').start()
        self.context = patch('ssl.create_default_context').start()
        self.sock = MagicMock()
        self.connect.return_value.__enter__.return_value = self.sock
    def tearDown(self):
        patch.stopall()
    def test_offline_never_creates_socket_or_tls_context(self):
        self.assertEqual(bridge.network_check('openai-api', 'none'), {'code': 'offline'})
        self.connect.assert_not_called()
        self.context.assert_not_called()
    def test_direct_tls_uses_fixed_provider_and_no_application_data(self):
        self.assertEqual(bridge.network_check('openai-api', 'internet'), {'code': 'reachable'})
        self.connect.assert_called_once_with(('api.openai.com', 443), timeout=3)
        self.context.return_value.wrap_socket.assert_called_once_with(self.sock, server_hostname='api.openai.com')
        self.sock.sendall.assert_not_called()
        self.sock.recv.assert_not_called()
        self.alarm.assert_any_call(8)
        self.alarm.assert_any_call(0)
    def test_codex_requires_both_auth_and_inference_domain_tls(self):
        self.assertEqual(bridge.network_check('openai-codex', 'internet')['code'], 'reachable')
        self.assertEqual([c.args[0] for c in self.connect.call_args_list], [('auth.openai.com', 443), ('chatgpt.com', 443)])
    def test_proxy_connect_uses_fixed_route_without_authentication(self):
        self.sock.recv.side_effect = [bytes([v]) for v in b'HTTP/1.1 200 Connected\r\n\r\n']
        self.assertEqual(bridge.network_check('anthropic', 'proxy')['code'], 'reachable')
        self.connect.assert_called_once_with(('hermes-egress', 3128), timeout=3)
        self.sock.sendall.assert_called_once_with(b'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n')
    def test_proxy_denial_is_sanitized_and_never_attempts_provider_tls(self):
        self.sock.recv.side_effect = [bytes([v]) for v in b'HTTP/1.1 403 Secret-Policy\r\n\r\n']
        self.assertEqual(bridge.network_check('openrouter', 'proxy'), {'code': 'proxy_blocked'})
        self.context.return_value.wrap_socket.assert_not_called()
    def test_proxy_header_is_bounded(self):
        self.sock.recv.return_value = b'x'
        self.assertEqual(bridge.network_check('openai-api', 'proxy')['code'], 'proxy_blocked')
        self.assertEqual(self.sock.recv.call_count, 4096)
    def test_dns_certificate_and_timeout_failures_return_no_exception_details(self):
        for error, code in [(socket.gaierror('private DNS data'), 'dns_failed'), (ssl.SSLError('certificate details'), 'tls_failed'), (TimeoutError('secret destination'), 'unavailable')]:
            with self.subTest(code=code):
                self.connect.side_effect = error
                self.assertEqual(bridge.network_check('openai-api', 'internet'), {'code': code})
    def test_arbitrary_endpoint_or_network_mode_is_refused(self):
        for provider, mode in [('https://private.invalid', 'internet'), ('openai-api', 'host')]:
            with self.assertRaises(ValueError):
                bridge.network_check(provider, mode)
        self.connect.assert_not_called()

if __name__ == '__main__':
    unittest.main()

"""Execute the pinned queue helpers without a gateway, credentials, or inference.

HERMES_SOURCE=/path/to/pinned/hermes python tests/fixtures/hermes-native-queue-contract.py
Only rendering primitives, admission, and the final turn dispatch are replaced; queue
decisions and post-turn continuation execute the actual unmodified source helpers.
"""
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ['HERMES_SOURCE'])
COMMIT = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != COMMIT:
    raise RuntimeError('Use the exact pinned Hermes source')
sys.path.insert(0, str(SOURCE))
from tui_gateway import prompt_turn, session_auto_continue as queue


@contextlib.contextmanager
def admission(session):
    with session['history_lock']:
        yield True


class NativeQueueContract(unittest.TestCase):
    def test_busy_self_copy_acknowledges_without_queuing(self):
        session = {'running': True, 'history_lock': threading.Lock(), 'inflight_turn': {'user': 'same message'}}
        with patch.multiple(queue, time=time, _coerce_message_text=str,
                            _is_text_only_busy_payload=lambda value: True,
                            _ok=lambda rid, result: {'result': result}, create=True):
            reply = queue._handle_busy_submit(1, 'owned', session, 'same message', None, queued=True)
        self.assertEqual(reply['result'], {'status': 'queued'})
        self.assertIsNone(session.get('queued_prompt'))
        self.assertIsNone(session.get('queued_prompts'))

    def test_failed_and_interrupted_turns_drain_accepted_next_prompt(self):
        for result in ({'error': 'synthetic provider error'}, {'interrupted': True}):
            with self.subTest(result=result):
                dispatched = []
                session = {'running': False, 'history_lock': threading.Lock(),
                           'queued_prompt': {'text': 'accepted next message', 'transport': None}}
                with patch.multiple(queue, _session_turn_admission=admission,
                                    _session_uses_compute_host=lambda session: False,
                                    _run_prompt_submit=lambda rid, sid, session, text, **kw: dispatched.append(text),
                                    create=True), patch.object(prompt_turn, '_drain_queued_prompt', queue._drain_queued_prompt, create=True):
                    prompt_turn._run_post_turn_followups(1, 'owned', session, result, None)
                self.assertEqual(dispatched, ['accepted next message'])
                self.assertTrue(session['running'])
                self.assertIsNone(session.get('queued_prompt'))


if __name__ == '__main__':
    unittest.main()

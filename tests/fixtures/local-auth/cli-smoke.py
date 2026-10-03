"""Hidden-TTY smoke test. Requires a NEW disposable collective_local_cli_test database, already migrated."""
import errno
import os
import pty
import select
import subprocess
import time
from urllib.parse import urlparse

assert urlparse(os.environ['DATABASE_URL']).path == '/collective_local_cli_test'
assert os.environ.get('AUTH_LOCAL_ENABLED') == 'true'
PASSWORD = 'Synthetic-cli-fixture-passphrase!42'
NEW_PASSWORD = 'Synthetic-cli-recovery-passphrase!43'


def run(command, password, expected):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['LOCAL_AUTH_OPERATOR'] = command
        os.execvp('node', ['node', '--import', 'tsx', 'scripts/local-account.ts', command])
    prompts = ([(b'New admin username: ', 'fixture-cli-admin'), (b'Display name: ', 'CLI Fixture'), (b'Email (optional): ', '')]
               if command == 'bootstrap' else [(b'Existing local admin username or email: ', 'fixture-cli-admin')])
    prompts += [(b'New password (hidden): ', password), (b'Confirm password (hidden): ', password)]
    transcript = b''
    seen = b''
    deadline = time.time() + 30
    while time.time() < deadline:
        if not select.select([fd], [], [], 0.25)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        transcript += chunk
        seen += chunk
        if prompts and prompts[0][0] in seen:
            _, answer = prompts.pop(0)
            os.write(fd, answer.encode() + b'\r')
            seen = b''
    else:
        os.kill(pid, 15)
        raise AssertionError('CLI timed out: ' + transcript.replace(password.encode(), b'[redacted]').decode(errors='replace'))
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    assert not prompts, 'CLI did not complete prompts'
    assert password.encode() not in transcript, 'Password was echoed'
    assert b'scrypt$' not in transcript, 'Hash appeared in output'
    assert os.waitstatus_to_exitcode(status) == expected, transcript.decode(errors='replace')

run('bootstrap', PASSWORD, 0)
run('bootstrap', PASSWORD, 1)
run('recover-admin', NEW_PASSWORD, 0)
env = dict(os.environ, LOCAL_AUTH_OPERATOR='bootstrap')
result = subprocess.run(['node', '--import', 'tsx', 'scripts/local-account.ts', 'bootstrap', PASSWORD], env=env, capture_output=True)
assert result.returncode != 0
assert PASSWORD.encode() not in result.stdout + result.stderr
print('PASS: hidden-TTY bootstrap, repeat rejection, admin recovery, argument rejection; no credential echo')

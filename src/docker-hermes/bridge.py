"""Allowlisted bridge for pinned official Hermes. No arbitrary paths or RPC from HTTP."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys

ROOT = Path('/opt/data')
SOURCE = Path('/opt/hermes')
COMMIT = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'
sys.path.insert(0, str(SOURCE))
os.environ.update(HERMES_HOME=str(ROOT), HERMES_DISABLE_LAZY_INSTALLS='1',
                  HERMES_LAZY_INSTALL_TARGET='', PYTHONDONTWRITEBYTECODE='1')
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')


def check_source():
    if (SOURCE / '.hermes_build_sha').read_text().strip() != COMMIT:
        raise ValueError('unsupported image revision')


@contextlib.contextmanager
def directory(parts):
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


def read_at(fd, name, limit=32768):
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        s = os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_size > limit or s.st_nlink != 1:
            raise ValueError('unsafe or oversized native file')
        return os.read(f, limit + 1).decode('utf-8', errors='replace')[:limit]
    finally:
        os.close(f)


def profile(name):
    if not NAME.fullmatch(name):
        raise ValueError('invalid profile')
    from hermes_cli.profiles import list_profile_names
    if name not in list_profile_names():
        raise ValueError('missing native profile')
    parts = [] if name == 'default' else ['profiles', name]
    with directory(parts) as fd:
        # Native creation seeds both; marker-only directories and backup names aren't imports.
        read_at(fd, 'SOUL.md')
        read_at(fd, 'config.yaml', 262144)
        s = os.fstat(fd)
        identity = f'{s.st_dev}:{s.st_ino}'
    return parts, identity


def clean(text):
    # Never read config/auth/env. Defense in depth for accidental secrets in user-authored resources.
    text = re.sub(r'(?i)(bearer\s+)[^\s"\']+', r'\1[redacted]', text)
    text = re.sub(r'\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}', '[redacted]', text)
    text = re.sub(r'(?im)^.*(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=].*$', '[redacted]', text)
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----', '[redacted]', text)
    return text


def profiles():
    from hermes_cli.profiles import list_profile_names
    out = []
    for name in list_profile_names()[:256]:
        if name != 'default' and re.search(r'(^|[-_])(backup|bak|archive|snapshot)([-_]|$)', name):
            continue
        try:
            _, identity = profile(name)
            out.append({'name': name, 'identity': identity})
        except (OSError, ValueError):
            pass
    return out


def resources(name, expected):
    parts, identity = profile(name)
    if identity != expected:
        raise ValueError('profile identity changed')
    skills, memories = [], []
    try:
        with directory(parts + ['skills']) as fd:
            # Native skills can be categorized, but never follow links or recurse without a bound.
            def walk(at, prefix='', depth=0):
                if depth > 4 or len(skills) >= 128:
                    return
                for entry in sorted(os.listdir(at))[:256]:
                    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', entry):
                        continue
                    try:
                        child = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=at)
                    except OSError:
                        continue
                    try:
                        try:
                            text = clean(read_at(child, 'SKILL.md'))
                            # Render as escaped text, never raw HTML or executable links.
                            skills.append({'id': prefix + entry, 'name': prefix + entry, 'content': text})
                        except FileNotFoundError:
                            walk(child, prefix + entry + '/', depth + 1)
                        except (OSError, ValueError):
                            pass
                    finally:
                        os.close(child)
            walk(fd)
    except (OSError, ValueError):
        pass
    try:
        with directory(parts + ['memories']) as fd:
            for name in ('MEMORY.md', 'USER.md'):
                try:
                    memories.append({'id': name, 'content': clean(read_at(fd, name))})
                except FileNotFoundError:
                    pass
    except (OSError, ValueError):
        pass
    return {'skills': skills, 'memories': memories}


def main():
    check_source()
    op = sys.argv[1]
    if op == 'check':
        print(json.dumps({'revision': COMMIT, 'uid': os.getuid()}))
    elif op == 'profiles':
        print(json.dumps(profiles()))
    elif op == 'create':
        name = sys.argv[2]
        if not re.fullmatch(r'cui-[a-f0-9]{32}', name):
            raise ValueError('only reserved generated names can be created')
        from hermes_cli.profiles import create_profile, list_profile_names
        if name not in list_profile_names():
            with contextlib.redirect_stdout(sys.stderr):
                create_profile(name, no_alias=True)
        print(json.dumps({'name': name, 'identity': profile(name)[1]}))
    elif op == 'resources':
        print(json.dumps(resources(sys.argv[2], sys.argv[3])))
    elif op == 'gateway':
        name, expected = sys.argv[2:4]
        parts, identity = profile(name)
        if identity != expected:
            raise ValueError('profile identity changed')
        home = ROOT.joinpath(*parts)
        # One lifetime lock per canonical profile, released by the kernel after container exit.
        with directory(parts) as fd:
            lock = os.open('.collectiveui-native.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # This preflight is a collision detector, not a lock honored by arbitrary native CLI.
        # Operators must stop UI ownership before starting independent native writers.
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit() or int(proc.name) == os.getpid():
                continue
            try:
                argv = (proc / 'cmdline').read_bytes().decode(errors='replace').split('\0')
                if not argv or not argv[0]:
                    continue
                native = any(Path(a).name in ('hermes', 'hermes-agent', 'hermes.py') or
                             a in ('hermes_cli', 'hermes_cli.main', 'tui_gateway.entry') or
                             '/hermes_cli/' in a or '/tui_gateway/' in a for a in argv)
                if '/opt/collective-bridge.py' in argv:
                    at = argv.index('/opt/collective-bridge.py')
                    if argv[at + 1:at + 3] == ['gateway', name]:
                        raise ValueError('profile already has a native process')
                    continue  # separate broker-owned profiles hold their own inode locks
                if not native:
                    continue
                env = dict(item.split('=', 1) for item in (proc / 'environ').read_bytes().decode(errors='replace').split('\0') if '=' in item)
                selected = None
                for i, arg in enumerate(argv):
                    if arg in ('-p', '--profile') and i + 1 < len(argv):
                        selected = argv[i + 1]
                    elif arg.startswith('--profile='):
                        selected = arg.split('=', 1)[1]
                other_home = ROOT if selected == 'default' else ROOT / 'profiles' / selected if selected else Path(env.get('HERMES_HOME', str(ROOT)))
                if selected is None and other_home == ROOT and (ROOT / 'active_profile').exists():
                    # The native selector may change after process launch. Ambiguity fails closed.
                    raise ValueError('active native profile is ambiguous')
                if other_home.resolve() == home.resolve():
                    raise ValueError('profile already has a native process')
            except (FileNotFoundError, ProcessLookupError):
                continue
            # Relevant unreadable metadata fails closed; never silently ignore PermissionError.
        if profile(name)[1] != expected:
            raise ValueError('profile changed during process admission')
        os.environ.update(HERMES_HOME=str(home), HOME=str(home / 'home'))
        os.chdir(home / 'workspace')
        runpy.run_module('tui_gateway.entry', run_name='__main__')
    else:
        raise ValueError('unknown operation')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Native errors may contain secret config. Deliberately do not serialize the exception.
        print('Native profile operation refused; inspect the profile inside its own runtime.', file=sys.stderr)
        sys.exit(1)

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
import time

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


def read_at(fd, name, limit=32768, strict=False):
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        s = os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_size > limit or s.st_nlink != 1:
            raise ValueError('unsafe or oversized native file')
        return os.read(f, limit + 1).decode('utf-8', errors='strict' if strict else 'replace')[:limit]
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


# These fields are the complete browser-editable surface, verified against COMMIT.
PROVIDERS = {
    'openai-api': ('OPENAI_API_KEY', 'https://api.openai.com/v1', 'OPENAI_BASE_URL'),
    'anthropic': ('ANTHROPIC_API_KEY', 'https://api.anthropic.com', 'ANTHROPIC_BASE_URL'),
    'openrouter': ('OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 'OPENROUTER_BASE_URL'),
}
CODEX = 'openai-codex'
CODEX_DEVICE = '.collectiveui-codex-device.json'
SUPPORTED_PROVIDERS = (*PROVIDERS, CODEX)
SETTINGS_FILES = ('config.yaml', '.env', 'auth.json', 'provider_models_cache.json')
JOURNAL = '.collectiveui-settings-transaction.json'
STAGE = '.collectiveui-settings-stage'
SETTINGS_TEMP = '.collectiveui-settings-write'
EFFORTS = ('', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')


def snapshot(fd):
    result = {}
    for name in SETTINGS_FILES:
        try:
            result[name] = read_at(fd, name, 1048576, strict=True)
        except FileNotFoundError:
            result[name] = None
    return result


def settings_revision(files):
    import hashlib
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def atomic_at(fd, name, value):
    temporary = SETTINGS_TEMP
    out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(out, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass


def restore_settings(fd, files):
    if set(files) != set(SETTINGS_FILES) or any(v is not None and not isinstance(v, str) for v in files.values()):
        raise ValueError('invalid recovery journal')
    for name, value in files.items():
        if value is None:
            try:
                os.unlink(name, dir_fd=fd)
            except FileNotFoundError:
                pass
        else:
            atomic_at(fd, name, value)
    os.fsync(fd)


def cleanup_settings_stage(fd):
    import shutil
    try:
        info = os.stat(STAGE, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError('unsafe native staging directory')
    shutil.rmtree(STAGE, dir_fd=fd)
    os.fsync(fd)


@contextlib.contextmanager
def settings_stage(fd):
    # Deterministic, profile-scoped and cleaned before every gateway admission/recovery.
    os.mkdir(STAGE, mode=0o700, dir_fd=fd)
    try:
        yield f'/proc/self/fd/{fd}/{STAGE}'
    finally:
        cleanup_settings_stage(fd)


def recover_settings(fd):
    cleanup_settings_stage(fd)
    try:
        info = os.stat(SETTINGS_TEMP, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe settings temporary file')
        os.unlink(SETTINGS_TEMP, dir_fd=fd)
        os.fsync(fd)
    except FileNotFoundError:
        pass
    try:
        original = json.loads(read_at(fd, JOURNAL, 32 * 1048576, strict=True))
    except FileNotFoundError:
        return
    restore_settings(fd, original)
    os.unlink(JOURNAL, dir_fd=fd)
    os.fsync(fd)


def parse_settings(files):
    import yaml
    from agent.secret_scope import _parse_env_text
    cfg = yaml.safe_load(files['config.yaml']) or {}
    if not isinstance(cfg, dict):
        raise ValueError('invalid config')
    env = _parse_env_text(files['.env'] or '')
    auth = json.loads(files['auth.json'] or '{}')
    if not isinstance(auth, dict):
        raise ValueError('invalid auth')
    return cfg, env, auth


def codex_models():
    from hermes_cli.codex_models import DEFAULT_CODEX_MODELS
    return list(DEFAULT_CODEX_MODELS)


def codex_connected(cfg, auth):
    state = (auth.get('providers') or {}).get(CODEX) or {}
    tokens = state.get('tokens') or {}
    return bool(tokens.get('access_token') and tokens.get('refresh_token') and
                (cfg.get('providers') or {}).get(CODEX, {}).get('enabled') is not False)


def stock_route(provider):
    from hermes_cli.auth import DEFAULT_CODEX_BASE_URL
    if provider == CODEX:
        return DEFAULT_CODEX_BASE_URL, 'codex_responses'
    modes = {'openai-api': 'codex_responses', 'anthropic': 'anthropic_messages', 'openrouter': 'chat_completions'}
    return PROVIDERS[provider][1], modes[provider]


def stock_endpoint(value, provider):
    # Full endpoint identity, never hostname-only ownership: custom paths/query/userinfo stay protected.
    from hermes_cli.route_identity import normalize_route_base_url
    return isinstance(value, str) and normalize_route_base_url(value) == normalize_route_base_url(stock_route(provider)[0])


def provider_auth_blocker(cfg, env, auth, provider):
    providers, pools, grants = cfg.get('providers') or {}, auth.get('credential_pool') or {}, auth.get('providers') or {}
    custom = cfg.get('custom_providers') or []
    if not all(isinstance(v, dict) for v in (providers, pools, grants)) or not isinstance(custom, list):
        return 'provider_configuration'
    entry = providers.get(provider, {})
    if not isinstance(entry, dict) or set(entry) - {'enabled'}:
        return 'provider_configuration'
    if any(not isinstance(p, dict) or p.get('name') == provider for p in custom):
        return 'custom_provider'
    if provider == CODEX:
        # Native Codex treats unset, blank and whitespace-only overrides as its default.
        endpoint = env.get('HERMES_CODEX_BASE_URL', '').strip()
        source = 'device_code'
    else:
        key, _, url_key = PROVIDERS[provider]
        endpoint = env.get(url_key, '')
        source = 'env:' + key
        if grants.get(provider):
            return 'provider_authentication'
        if provider == 'anthropic' and any(env.get(k) for k in ('ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')):
            return 'provider_authentication'
        if provider == 'openrouter' and env.get('CUSTOM_BASE_URL') and not stock_endpoint(env['CUSTOM_BASE_URL'], provider):
            return 'custom_endpoint'
    if endpoint and not stock_endpoint(endpoint, provider):
        return 'custom_endpoint'
    grant = grants.get(provider, {})
    if not isinstance(grant, dict) or grant.get('base_url') and not stock_endpoint(grant['base_url'], provider):
        return 'provider_authentication'
    entries = pools.get(provider, [])
    if not isinstance(entries, list) or not all(isinstance(e, dict) and e.get('source') == source and
            (not e.get('base_url') or stock_endpoint(e['base_url'], provider)) for e in entries):
        return 'credential_pool'
    return None


def route_blocker(cfg, env, auth, provider):
    """Prove stock saved routing before switching; never convert ambiguous/custom native state."""
    model = cfg.get('model', {})
    model = model if isinstance(model, dict) else {}
    # Native save_config normalizes legacy aliases, which could resurrect an unchecked URL.
    if any(cfg.get(k) for k in ('base_url', 'api_base')) or model.get('api_base'):
        return 'custom_endpoint'
    if cfg.get('provider'):
        return 'provider_configuration'
    if any(model.get(k) for k in ('api_key', 'api', 'key_env', 'api_key_env')):
        return 'model_authentication'
    runtime = model.get('openai_runtime')
    if runtime is not None and (not isinstance(runtime, str) or runtime.strip().lower() not in ('', 'auto')):
        return 'codex_runtime'
    saved_provider = model.get('provider')
    if saved_provider not in SUPPORTED_PROVIDERS and saved_provider not in (None, '', 'auto'):
        return 'provider_configuration'
    route_provider = saved_provider
    # The actual pinned image seeds provider:auto and the stock OpenRouter URL.
    if saved_provider in (None, '', 'auto') and stock_endpoint(model.get('base_url'), 'openrouter'):
        route_provider = 'openrouter'
    if model.get('base_url') or model.get('api_mode'):
        if route_provider not in SUPPORTED_PROVIDERS:
            return 'custom_endpoint' if model.get('base_url') else 'model_authentication'
        if model.get('base_url') and not stock_endpoint(model['base_url'], route_provider):
            return 'custom_endpoint'
        if model.get('api_mode') and model['api_mode'] != stock_route(route_provider)[1]:
            return 'model_authentication'
    # Check both sides, including pool-specific endpoints; source credentials stay untouched.
    target_blocker = provider_auth_blocker(cfg, env, auth, provider)
    if target_blocker:
        return target_blocker
    if route_provider in SUPPORTED_PROVIDERS and route_provider != provider:
        return provider_auth_blocker(cfg, env, auth, route_provider)
    return None


def simple_route(cfg, env, auth, provider):
    return route_blocker(cfg, env, auth, provider) is None


def codex_simple_route(cfg, env, auth):
    return simple_route(cfg, env, auth, CODEX)


def commit_native_settings(fd, original, updated):
    if snapshot(fd) != original:
        raise ValueError('native files changed during operation')
    atomic_at(fd, JOURNAL, json.dumps(original))
    try:
        restore_settings(fd, updated)
        os.unlink(JOURNAL, dir_fd=fd)
        os.fsync(fd)
    except BaseException:
        recover_settings(fd)
        raise


def change_codex_auth(fd, tokens=None):
    """New grant/local removal only. Never refresh, inherit or copy a grant to another profile."""
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    files = snapshot(fd)
    with settings_stage(fd) as stage:
        for name, value in files.items():
            if value is not None:
                p = Path(stage) / name
                p.write_text(value)
                p.chmod(0o600)
        previous = dict(os.environ)
        os.environ.update(HERMES_HOME=stage, HOME=str(Path(stage) / 'home'))
        scope = set_hermes_home_override(stage)
        try:
            from hermes_cli.auth import clear_provider_auth, _save_codex_tokens, unsuppress_credential_source, suppress_credential_source, _load_auth_store
            from hermes_cli.config import read_user_config_raw, save_config
            from agent.credential_pool import load_pool
            clear_provider_auth(CODEX)
            if tokens is not None:
                if any(not isinstance(tokens.get(k), str) or not tokens[k] for k in ('access_token', 'refresh_token')):
                    raise ValueError('incomplete native grant')
                _save_codex_tokens({k: tokens[k] for k in ('access_token', 'refresh_token')}, write_through=False)
                unsuppress_credential_source(CODEX, 'device_code')
                entries = load_pool(CODEX).entries()
                if not entries or any(e.source != 'device_code' or e.runtime_api_key != tokens['access_token'] for e in entries):
                    raise ValueError('native credential pool reconciliation failed')
            else:
                suppress_credential_source(CODEX, 'device_code')
            config = read_user_config_raw(Path(stage) / 'config.yaml')
            config.setdefault('providers', {}).setdefault(CODEX, {})['enabled'] = tokens is not None
            save_config(config, strip_defaults=False)
            if codex_connected(config, _load_auth_store()) != (tokens is not None):
                raise ValueError('native auth reconciliation failed')
            with directory_fd(stage) as stage_fd:
                updated = snapshot(stage_fd)
        finally:
            reset_hermes_home_override(scope)
            os.environ.clear()
            os.environ.update(previous)
    commit_native_settings(fd, files, updated)


def codex_device(fd):
    try:
        value = json.loads(read_at(fd, CODEX_DEVICE, 16384, strict=True))
    except FileNotFoundError:
        return None
    if not isinstance(value, dict) or not re.fullmatch(r'[a-f0-9-]{36}', value.get('sessionId', '')):
        raise ValueError('unsafe device state')
    return value


def codex_public(value):
    result = {k: value[k] for k in ('state', 'sessionId')}
    if value['state'] == 'pending':
        result.update(userCode=value['user_code'], verificationUrl='https://auth.openai.com/codex/device',
                      expiresAt=value['expiresAt'], nextPollAt=value['nextPollAt'])
    return result


def finish_codex_device(fd, value, state):
    clean = {'state': state, 'sessionId': value['sessionId']}
    atomic_at(fd, CODEX_DEVICE, json.dumps(clean))
    return clean


def recover_codex_device(fd):
    value = codex_device(fd)
    if value and value['state'] in ('pending', 'exchanging'):
        change_codex_auth(fd)
        finish_codex_device(fd, value, 'interrupted')


def profile_codex(name, expected, data):
    parts, identity = profile(name)
    if identity != expected:
        raise ValueError('profile identity changed')
    action = data.get('action')
    if action not in ('read', 'start', 'poll', 'cancel', 'disconnect', 'recover'):
        raise ValueError('invalid auth operation')
    with directory(parts) as fd:
        if action == 'read':
            value = codex_device(fd)
            if value and value['state'] == 'pending':
                return codex_public(value)
            cfg, _, auth = parse_settings(snapshot(fd))
            return {'state': 'connected' if codex_connected(cfg, auth) else 'disconnected'}
        lock = os.open('.collectiveui-native.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink != 1:
                raise ValueError('unsafe native lock')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert_no_other_native(name, ROOT.joinpath(*parts))
            recover_settings(fd)
            value = codex_device(fd)
            files = snapshot(fd)
            if action == 'recover':
                recover_codex_device(fd)
                if value and data.get('sessionId') == value['sessionId'] and value['state'] == 'connected':
                    # Native commit can finish just before broker revocation/death. A
                    # broker-interrupted receipt must clear that exact unconfirmed grant.
                    change_codex_auth(fd)
                    finish_codex_device(fd, value, 'interrupted')
                return {'state': 'interrupted'}
            if action in ('start', 'disconnect'):
                if data.get('revision') != settings_revision(files):
                    return {'error': 'conflict'}
                if not codex_simple_route(*parse_settings(files)):
                    return {'error': 'unsupported'}
            if action in ('poll', 'cancel'):
                if not value or value['sessionId'] != data.get('sessionId'):
                    return {'error': 'conflict'}
            if action in ('cancel', 'disconnect'):
                change_codex_auth(fd)
                if value:
                    finish_codex_device(fd, value, 'cancelled')
                return {'state': 'cancelled' if action == 'cancel' else 'disconnected'}
            if action == 'start':
                if not re.fullmatch(r'[a-f0-9-]{36}', data.get('sessionId', '')):
                    raise ValueError('invalid session')
                if settings_view(files)['provider'] != CODEX:
                    return {'error': 'unsupported'}
                change_codex_auth(fd)  # Reconnect replaces this profile's grant; cancel stays disconnected.
                value = {'sessionId': data['sessionId'], 'state': 'exchanging'}
                atomic_at(fd, CODEX_DEVICE, json.dumps(value))
            elif value['state'] == 'exchanging':
                recover_codex_device(fd)
                return {'state': 'interrupted', 'sessionId': value['sessionId']}
            elif value['state'] != 'pending':
                return codex_public(value)
            # Bound the ENTIRE native operation, including its supported transport retries.
            import signal
            class NativeDeadline(BaseException):
                pass
            def timeout(_signum, _frame):
                # Native transport retries catch Exception/OSError. The overall deadline
                # must escape those handlers without replaying a token exchange.
                raise NativeDeadline('native device operation deadline')
            previous_handler = signal.signal(signal.SIGALRM, timeout)
            signal.alarm(20)
            try:
                import httpx
                from hermes_cli.web_routers.oauth import _codex_request_user_code, _codex_exchange_tokens
                from hermes_cli.auth_codex import _codex_http_client
                if action == 'start':
                    device = _codex_request_user_code(httpx)
                    if not isinstance(device['user_code'], str) or not re.fullmatch(r'[A-Z0-9-]{3,32}', device['user_code']):
                        raise ValueError('invalid device code')
                    interval = max(3, min(60, int(device['interval'])))
                    value.update(state='pending', user_code=device['user_code'], device_auth_id=device['device_auth_id'],
                                 interval=interval, expiresAt=(time.time() + 900) * 1000, nextPollAt=(time.time() + interval) * 1000)
                    atomic_at(fd, CODEX_DEVICE, json.dumps(value))
                    return codex_public(value)
                if time.time() * 1000 >= value['expiresAt']:
                    return finish_codex_device(fd, value, 'expired')
                if time.time() * 1000 < value['nextPollAt']:
                    return codex_public(value)
                value['nextPollAt'] = (time.time() + value['interval']) * 1000
                atomic_at(fd, CODEX_DEVICE, json.dumps(value))
                # Native poll helper blocks for15min. Use its client and exact endpoint for one poll.
                with _codex_http_client(timeout=httpx.Timeout(15.0)) as client:
                    response = client.post('https://auth.openai.com/api/accounts/deviceauth/token',
                        json={'device_auth_id': value['device_auth_id'], 'user_code': value['user_code']},
                        headers={'Content-Type': 'application/json'})
                if response.status_code in (403, 404):
                    return codex_public(value)  # Native pending response; a proxy may also block it.
                if response.status_code != 200:
                    return finish_codex_device(fd, value, 'error')
                # Durable exchange marker: an interrupted exchange is NEVER automatically replayed.
                value['state'] = 'exchanging'
                atomic_at(fd, CODEX_DEVICE, json.dumps(value))
                tokens = _codex_exchange_tokens(httpx, response.json())
                if time.time() * 1000 >= value['expiresAt'] or profile(name)[1] != expected:
                    return finish_codex_device(fd, value, 'expired')
                change_codex_auth(fd, tokens)
                return finish_codex_device(fd, value, 'connected')
            except (Exception, NativeDeadline):
                # No exceptions, token previews, account identity or upstream bodies cross IPC.
                signal.alarm(0)
                change_codex_auth(fd)
                return finish_codex_device(fd, value, 'error')
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous_handler)
        finally:
            os.close(lock)


def settings_view(files):
    cfg, env, auth = parse_settings(files)
    model = cfg.get('model', {})
    if isinstance(model, str):
        model = {'default': model}
    if not isinstance(model, dict):
        raise ValueError('invalid model')
    agent = cfg.get('agent', {})
    if not isinstance(agent, dict):
        raise ValueError('invalid agent')
    name = model.get('default', '')
    effort, turns = agent.get('reasoning_effort', ''), agent.get('max_turns')
    if effort is False:
        effort = 'none'
    if effort is None:
        effort = ''
    supported = effort in EFFORTS and (turns is None or type(turns) is int and 1 <= turns <= 1000)
    return {'revision': settings_revision(files), 'provider': model.get('provider') if model.get('provider') in SUPPORTED_PROVIDERS else None,
            'model': name if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}', name) else '',
            'reasoningEffort': effort if effort in EFFORTS else '', 'maxTurns': turns if supported else None,
            'advancedSupported': supported,
            'editableProviders': {p: simple_route(cfg, env, auth, p) for p in SUPPORTED_PROVIDERS},
            # Fixed reason codes only: never export URLs, keys, credential sources or auth payloads.
            'providerBlockers': {p: route_blocker(cfg, env, auth, p) for p in SUPPORTED_PROVIDERS},
            'credentials': {**{p: bool(env.get(v[0])) for p, v in PROVIDERS.items()}, CODEX: codex_connected(cfg, auth)},
            'codexModels': codex_models()}


def validate_settings_input(data):
    if set(data) != {'revision', 'provider', 'model', 'reasoningEffort', 'maxTurns', 'credential'}:
        raise ValueError('invalid settings')
    if data['provider'] not in SUPPORTED_PROVIDERS or not isinstance(data['model'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}', data['model']):
        raise ValueError('invalid provider or model')
    if data['reasoningEffort'] not in EFFORTS or not (data['maxTurns'] is None or type(data['maxTurns']) is int and 1 <= data['maxTurns'] <= 1000):
        raise ValueError('invalid agent settings')
    credential = data['credential']
    if data['provider'] == CODEX and credential != {'action': 'keep'}:
        raise ValueError('use subscription connection controls')
    if not isinstance(credential, dict) or credential.get('action') not in ('keep', 'replace', 'clear'):
        raise ValueError('invalid credential action')
    if credential['action'] == 'replace':
        if set(credential) != {'action', 'value'} or not isinstance(credential['value'], str) or not re.fullmatch(r'[\x21-\x7e]{1,4096}', credential['value']):
            raise ValueError('invalid credential')
        if data['provider'] == 'anthropic' and credential['value'].startswith('sk-ant-oat'):
            raise ValueError('OAuth is not an API key')
    elif set(credential) != {'action'}:
        raise ValueError('invalid credential')


def stage_settings(files, data, fd):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    cfg, env, auth = parse_settings(files)
    provider = data['provider']
    if not settings_view(files)['advancedSupported'] or not simple_route(cfg, env, auth, provider):
        return {'error': 'unsupported'}
    key = PROVIDERS[provider][0] if provider in PROVIDERS else None
    with settings_stage(fd) as stage:
        os.chmod(stage, 0o700)
        for name, value in files.items():
            if value is not None:
                p = Path(stage) / name
                p.write_text(value)
                p.chmod(0o600)
        environment = dict(os.environ)
        os.environ.update(HERMES_HOME=stage, HOME=str(Path(stage) / 'home'))
        for env_key, _, url_key in PROVIDERS.values():
            os.environ.pop(env_key, None)
            os.environ.pop(url_key, None)
        token = set_hermes_home_override(stage)
        try:
            from hermes_cli.config import read_user_config_raw, save_config, clear_model_endpoint_credentials, load_env
            from hermes_cli.credential_lifecycle import save_provider_env_credential, remove_provider_env_credential
            from hermes_cli.auth import unsuppress_credential_source, suppress_credential_source, _load_auth_store
            from agent.credential_pool import load_pool
            action = data['credential']['action']
            if action == 'replace':
                # Remove old env-seeded pool first: upstream additive sync may retain a rotated key.
                remove_provider_env_credential(key)
                save_provider_env_credential(key, data['credential']['value'])
                # OpenRouter is intentionally absent from PROVIDER_REGISTRY in this release.
                unsuppress_credential_source(provider, 'env:' + key)
                load_pool(provider)
            elif action == 'clear':
                remove_provider_env_credential(key)
                suppress_credential_source(provider, 'env:' + key)
            cfg = read_user_config_raw(Path(stage) / 'config.yaml')
            model = cfg.get('model')
            model = dict(model) if isinstance(model, dict) else {}
            if model.get('provider') != provider:
                # Only the two proven-stock route fields belong to the previous provider.
                clear_model_endpoint_credentials(model, clear_api_key=False, clear_base_url=True)
            model.update(provider=provider, default=data['model'])
            cfg['model'] = model
            agent = cfg.setdefault('agent', {})
            agent['max_turns'] = data['maxTurns']
            agent['reasoning_effort'] = data['reasoningEffort'] or None
            saved_key = load_env().get(key) if key else codex_connected({}, _load_auth_store())
            # A cleared/missing local key must NOT silently borrow the root profile's auth pool.
            cfg.setdefault('providers', {}).setdefault(provider, {})['enabled'] = bool(saved_key)
            save_config(cfg, strip_defaults=False)
            actual = _load_auth_store().get('credential_pool', {}).get(provider, [])
            if action == 'replace' and (saved_key != data['credential']['value'] or not actual or any(e.source != 'env:' + key or e.runtime_api_key != saved_key for e in load_pool(provider).entries())):
                raise ValueError('credential reconciliation unconfirmed')
            if action == 'clear' and (saved_key or any(e.get('source') == 'env:' + key for e in actual)):
                raise ValueError('credential removal unconfirmed')
            with directory_fd(stage) as stage_fd:
                return snapshot(stage_fd)
        finally:
            reset_hermes_home_override(token)
            os.environ.clear()
            os.environ.update(environment)


@contextlib.contextmanager
def directory_fd(home):
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield fd
    finally:
        os.close(fd)


def profile_settings(name, expected, operation, data=None):
    parts, identity = profile(name)
    if identity != expected:
        raise ValueError('profile identity changed')
    with directory(parts) as fd:
        if operation in ('settings-read', 'settings-test'):
            try:
                os.stat(JOURNAL, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                files = snapshot(fd)
                if operation == 'settings-test':
                    if data.get('revision') != settings_revision(files):
                        return {'error': 'conflict'}
                    return {'code': test_settings(files)}
                return settings_view(files)
            raise ValueError('settings recovery required')
        lock = os.open('.collectiveui-native.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink != 1:
                raise ValueError('unsafe native lock')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert_no_other_native(name, ROOT.joinpath(*parts))
            recover_settings(fd)
            files = snapshot(fd)
            if data.get('revision') != settings_revision(files):
                return {'error': 'conflict'}
            if operation == 'settings-test':
                return {'code': test_settings(files)}
            validate_settings_input(data)
            updated = stage_settings(files, data, fd)
            if 'error' in updated:
                return updated
            if profile(name)[1] != expected or snapshot(fd) != files:
                return {'error': 'conflict'}
            if updated != files:
                atomic_at(fd, JOURNAL, json.dumps(files))
                try:
                    restore_settings(fd, updated)
                    os.unlink(JOURNAL, dir_fd=fd)
                    os.fsync(fd)
                except BaseException:
                    recover_settings(fd)
                    raise
            return settings_view(snapshot(fd))
        finally:
            os.close(lock)


def test_settings(files):
    """One explicit, bounded inference request. No chat session, tools, history, fallback or retries."""
    cfg, env, auth = parse_settings(files)
    view = settings_view(files)
    provider, model = view['provider'], view['model']
    if not provider or not model or not view['credentials'][provider]:
        return 'not_configured'
    if not simple_route(cfg, env, auth, provider):
        return 'unsupported'
    if provider == CODEX:
        return 'unsupported'  # This adapter reports sign-in, never claims inference is verified.
    key, base_url, _ = PROVIDERS[provider]
    if (cfg.get('providers') or {}).get(provider, {}).get('enabled') is False:
        return 'not_configured'
    try:
        # The SDKs are the ones installed by the pinned native release, inside this container.
        import httpx
        with httpx.Client(timeout=15, follow_redirects=False) as http:
            if provider == 'anthropic':
                from anthropic import Anthropic
                with Anthropic(api_key=env[key], base_url=base_url, max_retries=0, http_client=http) as client:
                    client.messages.create(model=model, max_tokens=8, messages=[{'role': 'user', 'content': 'Reply OK.'}])
            else:
                from openai import OpenAI
                with OpenAI(api_key=env[key], base_url=base_url, max_retries=0, http_client=http) as client:
                    if provider == 'openai-api':
                        client.responses.create(model=model, max_output_tokens=16, input='Reply OK.', store=False)
                    else:
                        client.chat.completions.create(model=model, max_tokens=8, messages=[{'role': 'user', 'content': 'Reply OK.'}])
        return 'verified'
    except Exception as error:
        status = getattr(error, 'status_code', None)
        if status == 401:
            return 'authentication_failed'
        if status in (400, 404, 422):
            return 'model_rejected'
        # 403 may be the egress proxy, not the provider. Never assert credential failure from it.
        return 'connection_failed'


def assert_no_other_native(name, home):
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
    elif op in ('settings-read', 'settings-save', 'settings-test'):
        data = None if op == 'settings-read' else json.loads(sys.stdin.read(16385))
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = profile_settings(sys.argv[2], sys.argv[3], op, data)
        print(json.dumps(result))
    elif op == 'codex':
        data = json.loads(sys.stdin.read(16385))
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = profile_codex(sys.argv[2], sys.argv[3], data)
        print(json.dumps(result))
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
        assert_no_other_native(name, home)
        with directory(parts) as fd:
            recover_settings(fd)
            recover_codex_device(fd)
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

"""Exercise the real bridge against a synthetic pinned-layout source; no native inference."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import types

filename, root, scenario = sys.argv[1:4]
spec = importlib.util.spec_from_file_location('bridge_fixture', filename)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.ROOT = Path(root) / 'volume'
bridge.ROOT.mkdir()
bridge.check_source = lambda: None
profiles = types.ModuleType('hermes_cli.profiles')
profiles.list_profile_names = lambda: ['default'] + [p.name for p in (bridge.ROOT / 'profiles').iterdir() if not p.name.startswith('.') and (p / 'SOUL.md').exists()]
sys.modules['hermes_cli.profiles'] = profiles
name = 'cui-team-' + 'a' * 32

def refuses(fn):
    try:
        fn()
    except (ValueError, OSError):
        return
    raise AssertionError('operation should refuse')

if scenario == 'blank':
    for filename, text in {'config.yaml': 'model: SECRET_COMPANY_KEY\n', '.env': 'OPENAI_API_KEY=SECRET_COMPANY_KEY\n', 'auth.json': '{"secret":"SECRET_COMPANY_KEY"}'}.items():
        (bridge.ROOT / filename).write_text(text)
    (bridge.ROOT / 'skills').mkdir(); (bridge.ROOT / 'skills' / 'private.txt').write_text('private skill')
    (bridge.ROOT / 'memories').mkdir(); (bridge.ROOT / 'memories' / 'USER.md').write_text('private memory')
    first = bridge.create_team(name)
    assert bridge.create_team(name) == first
    home = bridge.ROOT / 'profiles' / name
    assert (home / 'config.yaml').read_text() == '{}\n'
    assert (home / '.env').read_text() == ''
    assert (home / 'auth.json').read_text() == '{}\n'
    assert list((home / 'skills').iterdir()) == []
    assert list((home / 'memories').iterdir()) == []
    assert (home / 'gateway.parked').is_file()
    for p in home.iterdir():
        if p.is_file():
            assert 'SECRET_COMPANY_KEY' not in p.read_text()
            assert p.stat().st_mode & 0o077 == 0
    assert 'SECRET_COMPANY_KEY' in (bridge.ROOT / 'config.yaml').read_text()
elif scenario == 'unsafe':
    refuses(lambda: bridge.create_team('../escape'))
    refuses(lambda: bridge.create_team('default'))
    (bridge.ROOT / 'profiles').mkdir()
    unrelated = bridge.ROOT / 'unrelated'; unrelated.mkdir()
    (bridge.ROOT / 'profiles' / name).symlink_to(unrelated, target_is_directory=True)
    refuses(lambda: bridge.create_team(name))
    (bridge.ROOT / 'profiles' / name).unlink()
    bridge.create_team(name)
    home = bridge.ROOT / 'profiles' / name
    (home / bridge.TEAM_MARKER).write_text('{"format":2}')
    refuses(lambda: bridge.create_team(name))
elif scenario == 'crash':
    native_rename = bridge.os.rename
    failed = False
    def interrupted(*args, **kwargs):
        global failed
        if not failed:
            failed = True
            raise OSError('synthetic interrupted rename')
        return native_rename(*args, **kwargs)
    bridge.os.rename = interrupted
    refuses(lambda: bridge.create_team(name))
    assert name not in profiles.list_profile_names()
    first = bridge.create_team(name)
    assert bridge.create_team(name) == first
    assert profiles.list_profile_names() == ['default', name]
elif scenario == 'gateway':
    bridge.create_team(name)
    sys.argv = [filename, 'gateway', name, bridge.profile(name)[1]]
    refuses(bridge.main)
elif scenario == 'parked':
    bridge.create_team(name)
    home = bridge.ROOT / 'profiles' / name
    serving_spec = importlib.util.spec_from_file_location('serving_fixture', Path(filename).parents[2] / 'tests' / 'fixtures' / 'hermes-native-profiles-serving.py')
    serving = importlib.util.module_from_spec(serving_spec)
    serving_spec.loader.exec_module(serving)
    serving.get_active_profile_name = lambda: 'default'
    serving._get_default_hermes_home = lambda: bridge.ROOT
    serving._iter_named_profile_dirs = lambda: [home]
    serving.profile_is_standalone = lambda _: False
    serving.get_profile_dir = lambda _: bridge.ROOT
    assert serving.profiles_to_serve(True) == [('default', bridge.ROOT)]
    assert serving.profiles_to_serve(True, include_parked=True) == [('default', bridge.ROOT), (name, home)]
    (home / 'gateway.parked').unlink()
    refuses(lambda: bridge.create_team(name))
    refuses(lambda: bridge.profile(name))
elif scenario == 'legacy':
    bridge.create_team(name)
    home = bridge.ROOT / 'profiles' / name
    (home / bridge.TEAM_MARKER).unlink()
    (home / 'gateway.parked').unlink()
    assert bridge.profile(name)[0] == ['profiles', name]
    assert {'name': name, 'identity': bridge.profile(name)[1]} in bridge.profiles()
else:
    raise AssertionError('unknown scenario')
print(json.dumps({'passed': scenario}))

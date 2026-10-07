"""Production collision scanner against a private kernel-metadata and sealed-image fixture.

No Docker, native gateway, script execution, credentials or network requests.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('bridge', HERE.parents[1] / 'src/docker-hermes/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
ARGV = ['/bin/sh', '-e', '/run/s6/basedir/scripts/rc.init', 'top',
        '/opt/hermes/docker/main-wrapper.sh', 'sleep', 'infinity']
FILES = {'/run/s6/basedir/scripts/rc.init': ('rc.init', 'bf6a4575f0029b66913623356e3c56553514a86bcf693fae6432617c73977747'),
         '/opt/hermes/docker/main-wrapper.sh': ('main-wrapper.sh', 'f722b0a99d4d544415add8d6b8013c79ec1c2bf3bb145da551474e3c3193b2da')}


class NativeProcesses(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cui-native-processes-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.process_root = self.root / 'proc'
        self.process_root.mkdir()
        self.image = self.root / 'image'
        self.image.mkdir(mode=0o755)
        for destination, (filename, expected) in FILES.items():
            content = (HERE / 'hermes-team-image-supervisor' / filename).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), expected)
            target = self.image / destination.lstrip('/')
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755)
        self.pid = os.getpid() + 100_000
        self.uid = 0
        actual_open, actual_fstat = os.open, os.fstat
        def process_path(*args, **kwargs):
            value = Path(*args, **kwargs)
            return self.process_root if value == Path('/proc') else value
        def image_open(value, flags, *args, **kwargs):
            return actual_open(str(self.image) if value == '/' else value, flags, *args, **kwargs)
        def root_metadata(fd):
            value = actual_fstat(fd)
            # Kernel root ownership is synthetic; real inode/type/mode/link/size and
            # O_NOFOLLOW directory traversal remain under the production verifier.
            return types.SimpleNamespace(st_uid=self.uid, st_mode=value.st_mode,
                                         st_nlink=value.st_nlink, st_size=value.st_size)
        for mock in (patch.object(bridge, 'Path', side_effect=process_path),
                     patch.object(os, 'open', side_effect=image_open),
                     patch.object(os, 'fstat', side_effect=root_metadata)):
            mock.start()
            self.addCleanup(mock.stop)

    def process(self, argv=ARGV, uid='0\t0\t0\t0', ppid=1, name='rc.init'):
        proc = self.process_root / str(self.pid)
        proc.mkdir(exist_ok=True)
        (proc / 'cmdline').write_bytes(('\0'.join(argv) + '\0').encode())
        (proc / 'status').write_text(f'Name:\t{name}\nPPid:\t{ppid}\nUid:\t{uid}\n')
        return proc

    def scan(self):
        bridge.assert_no_other_native('team', self.root, exclusive_runtime=True)

    def test_exact_pinned_idle_supervisor_needs_no_environment_or_exe_access(self):
        self.assertEqual(bridge.IDLE_IMAGE_SCRIPTS, tuple((path, expected) for path, (_, expected) in FILES.items()))
        self.process(name='forgeable-name-is-irrelevant')
        self.scan()  # No environ/exe/cwd records exist, matching UID 10000 visibility.

    def test_explicit_native_or_bridge_markers_are_never_exempt(self):
        for argv in (['hermes'], ['python', '-m', 'hermes_cli.main'],
                     ['python', '/opt/collective-bridge.py', 'gateway', 'default'],
                     ['/opt/hermes/.venv/bin/python', '/opt/hermes/run_agent.py'],
                     [*ARGV, 'hermes'], [*ARGV[:-2], 'hermes', 'gateway']):
            with self.subTest(argv=argv):
                self.process(argv)
                with self.assertRaises(ValueError):
                    self.scan()

    def test_unknown_source_command_and_changed_wrapper_command_are_refused(self):
        for argv in (['/bin/sh', '/opt/hermes/unknown-script.sh'],
                     [*ARGV[:-1], '60'], [*ARGV, 'extra'],
                     ['/usr/bin/python3', '-c', 'pass', *ARGV[2:]],
                     [*ARGV[:3], 'other-top', *ARGV[4:]]):
            with self.subTest(argv=argv):
                self.process(argv)
                with self.assertRaises(ValueError):
                    self.scan()

    def test_forged_name_root_transition_and_non_init_parent_are_refused(self):
        for uid, ppid in (('10000\t10000\t10000\t10000', 1), ('0\t10000\t0\t0', 1), ('0\t0\t0\t0', 17)):
            with self.subTest(uid=uid, ppid=ppid):
                self.process(uid=uid, ppid=ppid)
                with self.assertRaises(ValueError):
                    self.scan()

    def test_malformed_status_is_refused(self):
        proc = self.process()
        for status in ('Name:\trc.init\n', 'Uid:\t0\t0\t0\nPPid:\t1\n', 'Uid:\t0\t0\t0\t0\nPPid:\t1\n' + 'x' * 8192):
            with self.subTest(status=status[:30]):
                (proc / 'status').write_text(status)
                with self.assertRaises(ValueError):
                    self.scan()
        (proc / 'status').unlink()
        with self.assertRaises(ValueError):
            self.scan()

    def test_unreadable_kernel_metadata_is_refused(self):
        proc = self.process()
        actual_open = Path.open
        def denied(value, *args, **kwargs):
            if value == proc / 'status':
                raise PermissionError('Unreadable fixture status')
            return actual_open(value, *args, **kwargs)
        with patch.object(Path, 'open', denied), self.assertRaises(PermissionError):
            self.scan()

    def test_changed_missing_or_writable_script_is_refused(self):
        self.process()
        for destination in FILES:
            target = self.image / destination.lstrip('/')
            before = target.read_bytes()
            for mutation in ('hash', 'missing', 'writable'):
                with self.subTest(destination=destination, mutation=mutation):
                    if mutation == 'hash': target.write_bytes(before + b'changed')
                    elif mutation == 'missing': target.unlink()
                    else: target.chmod(0o775)
                    with self.assertRaises(ValueError):
                        self.scan()
                    target.write_bytes(before)
                    target.chmod(0o755)

    def test_non_root_owned_or_symlinked_script_tree_is_refused(self):
        self.process()
        self.uid = 10000
        with self.assertRaises(ValueError): self.scan()
        self.uid = 0
        target = self.image / 'run/s6/basedir/scripts/rc.init'
        content = target.read_bytes()
        alternate = self.image / 'other-script'
        alternate.write_bytes(content)
        target.unlink()
        target.symlink_to(alternate)
        with self.assertRaises(ValueError): self.scan()
        target.unlink()
        target.write_bytes(content)
        target.chmod(0o755)
        scripts = target.parent
        scripts.rename(self.image / 'other-scripts')
        scripts.symlink_to(self.image / 'other-scripts', target_is_directory=True)
        with self.assertRaises(ValueError): self.scan()


if __name__ == '__main__':
    unittest.main()

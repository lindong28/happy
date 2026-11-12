import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('relay_service', Path(__file__).with_name('macos-service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['HAPPY_SERVICE_TEST_ROOT'])
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.config = self.home / 'config.json'
        self.tunnel = self.home / 'tunnel.json'
        self.tunnel.write_text(json.dumps({'tunnel': 'test-id', 'protocol': 'http2', 'ingress': [
            {'hostname': 'happy.example.test', 'service': 'http://127.0.0.1:3005'}, {'service': 'http_status:404'}]}))
        self.config.write_text(json.dumps({'node': '/usr/bin/true', 'cloudflared': '/usr/bin/true',
            'package': str(self.home), 'tunnel_config': str(self.tunnel), 'tunnel_id': 'test-id',
            'environment': {'HOST': '127.0.0.1', 'PORT': '3005', 'PUBLIC_URL': 'https://happy.example.test',
                            'HANDY_MASTER_SECRET': 'fixture', 'HAPPY_ALLOWED_PUBLIC_KEYS': 'a' * 64}}))
        self.config.chmod(0o600)
        self.loaded = {}
        self.bootouts = []
        self.fail_server = False
        self.home_patch = patch.object(service.Path, 'home', return_value=self.home)
        self.home_patch.start(); self.addCleanup(self.home_patch.stop)
        self.run_patch = patch.object(service.subprocess, 'run', side_effect=self.launchctl)
        self.run_patch.start(); self.addCleanup(self.run_patch.stop)

    def launchctl(self, args, **kw):
        action, label = args[1], args[2].split('/')[-1]
        if action == 'print':
            if label not in self.loaded:
                return subprocess.CompletedProcess(args, 113, '' if kw.get('text') else b'', '')
            output = 'arguments = {\n' + '\n'.join(self.loaded[label]) + '\n}\n'
            return subprocess.CompletedProcess(args, 0, output if kw.get('text') else output.encode(), '')
        if action == 'bootout':
            self.bootouts.append(label)
            if self.fail_server and label.endswith('.server'):
                raise subprocess.CalledProcessError(5, args)
            self.loaded.pop(label, None)
        return subprocess.CompletedProcess(args, 0, b'', b'')

    def invoke(self, *args):
        with patch.object(service.sys, 'argv', ['service', *args]):
            return service.main()

    def install(self):
        self.assertEqual(self.invoke('install', '--config', str(self.config)), 0)
        root, agents = service.paths(self.home)
        state = json.loads((root / 'owner.json').read_text())
        return root, agents, state

    def test_install_idempotent_and_uninstall_preserves_data(self):
        root, _, state = self.install()
        self.assertEqual(self.invoke('install', '--config', str(self.config)), 0)
        (root / 'data').mkdir(); (root / 'data/keep').write_text('session')
        self.assertEqual(self.invoke('uninstall'), 0)
        self.assertEqual((root / 'data/keep').read_text(), 'session')
        self.assertFalse((root / 'owner.json').exists())

    def test_foreign_loaded_job_is_not_adopted_or_stopped(self):
        self.loaded[service.LABEL + '.server'] = ['/foreign/service']
        with self.assertRaisesRegex(ValueError, 'Unowned loaded'):
            self.install()
        self.assertEqual(self.bootouts, [])

    def test_changed_live_job_preserved(self):
        self.install()
        self.loaded[service.LABEL + '.server'] = ['/foreign/service']
        with self.assertRaisesRegex(ValueError, 'another source'):
            self.invoke('stop')
        self.assertEqual(self.bootouts, [])

    def test_failed_uninstall_keeps_proof_and_can_retry(self):
        root, agents, state = self.install()
        self.loaded = {service.LABEL + '.' + k: v for k, v in state['arguments'].items()}
        self.fail_server = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke('uninstall')
        self.assertIsNotNone(service.check_owner(root, agents))
        self.fail_server = False
        self.assertEqual(self.invoke('uninstall'), 0)

    def test_explicit_public_or_empty_private_config_refused(self):
        self.config.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private'):
            self.invoke('install', '--config', str(self.config))


if __name__ == '__main__':
    unittest.main()

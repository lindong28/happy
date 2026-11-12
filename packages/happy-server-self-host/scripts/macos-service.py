#!/usr/bin/env python3
"""Own a macOS Happy relay server, independently of its public ingress.

Provision the tunnel separately with Cloudflare's CLI. This installer never
creates DNS, copies a connector identity, or takes over another installation.
"""
import argparse
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys

OWNER = str(Path(__file__).resolve())
LABEL = 'local.happy-personal-relay'


def paths(home):
    root = home / '.local/share/happy-personal-relay'
    return root, home / 'Library/LaunchAgents'


def load_config(path):
    if path.stat().st_mode & 0o077:
        raise ValueError('Relay config must be private (chmod 600)')
    c = json.loads(path.read_text())
    for key in ['node', 'package']:
        p = Path(c[key])
        if not p.is_absolute() or not p.exists():
            raise ValueError('Missing absolute prerequisite: ' + key)
    env = c['environment']
    if not env.get('HANDY_MASTER_SECRET') or not env.get('HAPPY_ALLOWED_PUBLIC_KEYS'):
        raise ValueError('Private relay requires master secret and allowed public keys')
    if env.get('HOST') != '127.0.0.1' or not env.get('PUBLIC_URL', '').startswith('https://'):
        raise ValueError('Relay requires loopback origin and public HTTPS URL')
    return c


def check_owner(root, agents):
    def loaded_arguments(role):
        result = subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{LABEL}.{role}'], capture_output=True, text=True, timeout=10)
        if result.returncode:
            # launchctl uses 113 for an unknown service; other failures cannot
            # establish vacancy (for example an unavailable login domain).
            if result.returncode == 113:
                return None
            raise ValueError('Cannot establish loaded LaunchAgent ownership')
        lines = [line.strip() for line in result.stdout.splitlines()]
        try:
            start = lines.index('arguments = {') + 1
            end = lines.index('}', start)
            return lines[start:end]
        except ValueError:
            raise ValueError('Loaded LaunchAgent arguments unavailable')
    record = root / 'owner.json'
    if record.exists():
        state = json.loads(record.read_text())
        if state['owner'] != OWNER:
            raise ValueError('Different source owns this service; use its uninstall first')
        for role in ['server']:
            path = agents / f'{LABEL}.{role}.plist'
            if not path.exists() or plistlib.loads(path.read_bytes())['ProgramArguments'] != state['arguments'][role]:
                raise ValueError('LaunchAgent ownership mismatch; preserving incumbent')
            loaded = loaded_arguments(role)
            if loaded is not None and loaded != state['arguments'][role]:
                raise ValueError('Loaded LaunchAgent belongs to another source; preserving incumbent')
        return state
    if any((agents / f'{LABEL}.{r}.plist').exists() for r in ['server']):
        raise ValueError('Unowned LaunchAgent exists; preserving incumbent')
    if any(loaded_arguments(r) is not None for r in ['server']):
        raise ValueError('Unowned loaded LaunchAgent exists; preserving incumbent')
    return None


def run_role(root, config, role):
    c = load_config(config)
    # launchd handles lifecycle/restarts; this process exclusively owns its child.
    with (root / f'{role}.run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = {**os.environ, **c['environment']}
        command = [c['node'], str(Path(c['package']) / 'dist/standalone.mjs'), 'serve']
        log = logging.getLogger(role)
        log.setLevel(logging.INFO)
        handler = RotatingFileHandler(root / f'{role}.log', maxBytes=5_000_000, backupCount=2)
        log.addHandler(handler)
        child = subprocess.Popen(command, cwd=c['package'], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        def stop(_sig, _frame):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        for line in child.stdout:
            log.info(line.rstrip())
        code = child.wait()
        log.info('Child exited: %s', code)
        return code


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['install', 'start', 'stop', 'status', 'uninstall', 'run'])
    p.add_argument('--config', type=Path)
    p.add_argument('--role', choices=['server'])
    args = p.parse_args()
    root, agents = paths(Path.home())
    os.umask(0o077)
    root.mkdir(parents=True, exist_ok=True)
    if args.action == 'run':
        if not args.config or not args.role:
            raise ValueError('run requires config and role')
        return run_role(root, args.config, args.role)
    with (root / 'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = check_owner(root, agents)
        if args.action == 'install':
            if not args.config:
                raise ValueError('install requires --config')
            config = args.config.resolve(strict=True)
            load_config(config)
            if state:
                if state['config'] != str(config):
                    raise ValueError('Configuration path changed; stop/uninstall before handoff')
                print('Already installed; not restarted.')
                return 0
            agents.mkdir(parents=True, exist_ok=True)
            arguments = {r: [sys.executable, OWNER, 'run', '--config', str(config), '--role', r] for r in ['server']}
            for role, command in arguments.items():
                spec = {'Label': f'{LABEL}.{role}', 'ProgramArguments': command,
                        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
                        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
                        'ProcessType': 'Background', 'ExitTimeOut': 20}
                (agents / f'{LABEL}.{role}.plist').write_bytes(plistlib.dumps(spec))
            (root / 'owner.json').write_text(json.dumps({'owner': OWNER, 'config': str(config), 'arguments': arguments}) + '\n')
            print('Installed. Not started. Run migrate, then start. Phone acceptance pending.')
            return 0
        if state is None:
            print('Not installed; no service changed.')
            return 1 if args.action == 'start' else 0
        domain = f'gui/{os.getuid()}'
        for role in ['server']:
            label = f'{LABEL}.{role}'
            path = agents / (label + '.plist')
            current = subprocess.run(['launchctl', 'print', domain + '/' + label], capture_output=True)
            if args.action == 'status':
                lines = current.stdout.decode().splitlines()
                fields = [s.strip() for s in lines if s.strip().startswith(('state =', 'pid =', 'last exit code ='))]
                print(label + ': ' + (', '.join(fields) if current.returncode == 0 else 'not loaded'))
            elif args.action == 'start':
                load_config(Path(state['config']))
                if current.returncode:
                    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, timeout=30)
            else:
                if current.returncode == 0:
                    subprocess.run(['launchctl', 'bootout', domain + '/' + label], check=True, timeout=30)
        if args.action == 'uninstall':
            # Keep the complete ownership proof if either bootout fails, so the
            # operator can retry stop/start/uninstall through this same entry.
            for role in ['server']:
                (agents / f'{LABEL}.{role}.plist').unlink()
            (root / 'owner.json').unlink()
            print('Uninstalled. Database and account keys retained; public ingress unchanged.')
        elif args.action == 'status':
            print('Process status only; HTTPS/Socket.IO and phone availability require separate checks.')
        return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    except (OSError, KeyError, subprocess.SubprocessError) as e:
        # Do not dump config, process environment or credential-bearing command lines.
        print(type(e).__name__ + ': service action failed; inspect configuration and owned service logs.', file=sys.stderr)
        sys.exit(2)

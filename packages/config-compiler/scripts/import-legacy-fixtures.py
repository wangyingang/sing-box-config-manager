#!/usr/bin/env python3
"""Explicit, offline fixture refresh. Never copies raw credentials to the destination."""
import argparse
import base64
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ALIASES = dict(zip(('wangyingang', 'wangdao', 'baili', 'zhongni'), ('user-a', 'user-b', 'user-c', 'user-d')))


def alias(value):
    for original, replacement in ALIASES.items():
        value = value.replace(original, replacement)
    return value


def sanitize(value, forbidden):
    if isinstance(value, list):
        return [sanitize(item, forbidden) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    secrets = {'uuid', 'password', 'secret', 'private_key', 'public_key', 'short_id'}
    for key, item in value.items():
        if key in secrets and isinstance(item, str) and item:
            forbidden.add(item)
            if key == 'uuid': item = '00000000-0000-4000-8000-000000000001'
            elif key == 'short_id': item = '0123456789abcdef'
            elif key in ('private_key', 'public_key'): item = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('=')
            else:
                size = 16 if 'aes-128' in value.get('method', '') else 32
                item = base64.b64encode(bytes(range(size))).decode()
        elif key == 'client_subnet':
            forbidden.add(item)
            item = '8.8.8.0/24'
        result[key] = sanitize(item, forbidden)
    # Physical outbounds only; keep public DNS addresses and routing match conditions.
    if 'server_port' in result and value.get('type') in ('vless', 'shadowsocks', 'hysteria2', 'trojan'):
        forbidden.add(value['server'])
        try:
            ipv6 = ipaddress.ip_address(value['server']).version == 6
        except ValueError:
            ipv6 = False
        result['server'] = '2001:db8::10' if ipv6 else '192.0.2.10'
        if 'tls' in result and 'server_name' in result['tls']:
            result['tls']['server_name'] = 'fixture.example.invalid'
        if 'transport' in result:
            transport = result['transport']
            if 'path' in transport:
                forbidden.add(value['transport']['path'])
                transport['path'] = '/fixture'
            if 'headers' in transport:
                transport['headers'] = {'Host': 'fixture.example.invalid'}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-repo', type=Path, required=True)
    parser.add_argument('--rule-repo', type=Path, required=True)
    parser.add_argument('--sing-box', required=True)
    args = parser.parse_args()
    version = subprocess.check_output([args.sing_box, 'version'], text=True)
    if version.splitlines()[0] != 'sing-box version 1.14.4':
        raise SystemExit('requires exactly sing-box 1.14.4')
    revision = lambda repo: subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    spec = importlib.util.spec_from_file_location('legacy', args.config_repo / 'scripts/generate_configs.py')
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    fixtures = ROOT / 'test/fixtures/legacy'
    fixtures.mkdir(parents=True, exist_ok=True)
    manifest = {'configRevision': revision(args.config_repo), 'ruleRevision': revision(args.rule_repo), 'binaryVersion': version.strip(), 'cases': [], 'artifacts': []}
    artifacts = {}
    forbidden = set()
    documents = {}
    for user in generator.USERS:
        for mode in ['tun'] + (['android-tun'] if user == 'wangdao' else []):
            names = generator.snippet_names(args.config_repo / 'snippets', user, mode)
            fragments = {}
            for name in sorted(names):
                document = sanitize(json.loads((args.config_repo / 'snippets' / name).read_text()), forbidden)
                for rule_set in document.get('route', {}).get('rule_set', []):
                    if rule_set.get('type') != 'remote':
                        continue
                    relative = rule_set['url'].split('/main/', 1)[1]
                    rule_set.setdefault('format', 'binary' if relative.endswith('.srs') else 'source')
                    rule_set['url'] = rule_set['url'].replace('/main/', '/' + manifest['ruleRevision'] + '/')
                    content = (args.rule_repo / relative).read_bytes()
                    source = json.loads((args.rule_repo / relative).with_suffix('.json').read_text())
                    def fields(obj):
                        if isinstance(obj, dict):
                            return set(obj) | set().union(*(fields(v) for v in obj.values()))
                        if isinstance(obj, list):
                            return set().union(*(fields(v) for v in obj))
                        return set()
                    capabilities = []
                    if fields(source) & {'process_name', 'process_path', 'process_path_regex'}:
                        capabilities.append('processMatching')
                    if fields(source) & {'package_name', 'package_name_regex'}:
                        capabilities.append('packageMatching')
                    artifacts[rule_set['tag']] = {'id': rule_set['tag'], 'revision': manifest['ruleRevision'], 'sha256': hashlib.sha256(content).hexdigest(), 'url': rule_set['url'], 'format': rule_set['format'], 'requiredCapabilities': capabilities}
                fragments[alias(name)] = document
            case_id = ALIASES[user] + '-' + mode
            # The official merge is the oracle, never the new Composer.
            with tempfile.TemporaryDirectory(prefix='d06-oracle-') as temporary:
                stage = Path(temporary)
                command = [args.sing_box, 'merge', str(stage / 'result.json')]
                for name, document in fragments.items():
                    path = stage / name
                    path.write_text(json.dumps(document))
                    command.extend(['-c', str(path)])
                subprocess.run(command, check=True, capture_output=True)
                subprocess.run([args.sing_box, 'check', '-c', str(stage / 'result.json')], check=True, capture_output=True)
                golden = json.loads((stage / 'result.json').read_text())
            documents[case_id + '.json'] = {'fragments': fragments, 'golden': golden}
            manifest['cases'].append({'id': case_id, 'profile': 'android-google-play' if mode == 'android-tun' else 'macos-standalone'})
    manifest['artifacts'] = list(artifacts.values())
    documents['manifest.json'] = manifest
    encoded = {name: json.dumps(value, ensure_ascii=False, indent=2) + '\n' for name, value in documents.items()}
    # Refuse all output if an original credential, node address, ECS or transport path survived.
    for text in encoded.values():
        if any(secret in text for secret in forbidden if len(secret) >= 8):
            raise SystemExit('sanitization failed; no fixture written')
    for name, text in encoded.items():
        (fixtures / name).write_text(text)
    print(f'Wrote {len(manifest["cases"])} sanitized cases and {len(artifacts)} artifact records; official merge/check passed.')


if __name__ == '__main__':
    main()

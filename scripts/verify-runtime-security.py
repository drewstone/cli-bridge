#!/usr/bin/env python3
"""Real shipped-image npm/Python/native proof. Uses no credentials or model calls."""
import json
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys


def interrupted(number, _frame):
    raise SystemExit(128 + number)


for interrupt in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(interrupt, interrupted)


image = sys.argv[1]
kind = sys.argv[2]
if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
    raise SystemExit('an existing immutable Docker image ID is required')
if kind not in ('runtime', 'bridge'):
    raise SystemExit('the producer must specify runtime (all harnesses) or bridge')
source = subprocess.run(['docker', 'image', 'inspect', image, '--format',
                         '{{index .Config.Labels "org.opencontainers.image.source"}}'],
                        check=True, capture_output=True, text=True, timeout=30).stdout.strip()
if source != 'https://github.com/drewstone/cli-bridge':
    raise SystemExit('the image is missing its maintained source ownership label')
descriptor = json.loads((Path(__file__).parent / 'npm-security.json').read_text())
overrides = dict(line.strip().split('==') for line in
                 (Path(__file__).parent / 'python-security-overrides.txt').read_text().splitlines()
                 if line.strip() and not line.startswith('#'))


def run(entrypoint, arguments, source=None):
    name = 'cli-security-proof-' + secrets.token_hex(8)
    try:
        result = subprocess.run(['docker', 'run', '--rm', '-i', '--name', name,
                                 '--network', 'none', '--entrypoint', entrypoint,
                                 image, *arguments], input=source, capture_output=True,
                                text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'image proof failed ({entrypoint}): {result.stderr[-2000:]}')
        return result.stdout.strip()
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True, timeout=30)


harnesses = ['claude', 'codex', 'opencode', 'kimi']
if kind == 'runtime':
    harnesses += ['gemini', 'pi']
versions = {cli: run(cli, ['--version']) for cli in ['node', 'npm', *harnesses]}
if versions['npm'] != descriptor['version']:
    raise SystemExit('the image npm version does not match its security owner')
npm_dependencies = json.loads(run('node', ['-e', "console.log(JSON.stringify(Object.fromEntries(['brace-expansion','undici'].map(n=>[n,require('/usr/local/lib/node_modules/npm/node_modules/'+n+'/package.json').version]))))"]))
python_source = r'''
import asyncio, email.parser, importlib.metadata, io, json, pathlib, re
import aiohttp, aiohttp.web, asyncssh, kimi_cli
from lxml import etree
from lxml_html_clean import Cleaner
from PIL import Image
expected = json.loads(__import__('sys').argv[1])
normalize = lambda value: re.sub(r'[-_.]+', '-', value).lower()
installed = {name: importlib.metadata.version(name) for name in expected}
if installed != expected:
    raise SystemExit('the actual Kimi environment does not match security overrides')
cache = {}
for metadata in pathlib.Path('/root/.cache/uv/archive-v0').glob('*/*.dist-info/METADATA'):
    parsed = email.parser.Parser().parsestr(metadata.read_text())
    name = normalize(parsed['Name'] or '')
    for wanted, version in expected.items():
        if name == normalize(wanted):
            cache.setdefault(wanted, []).append({'version': parsed['Version'], 'path': str(metadata)})
            if parsed['Version'] != version:
                raise SystemExit('the UV archive retains a superseded security package')
if set(cache) != set(expected):
    raise SystemExit('targeted UV archive coverage is incomplete')
async def roundtrip():
    app = aiohttp.web.Application()
    app.router.add_get('/', lambda request: aiohttp.web.Response(text='native-http-ok'))
    runner = aiohttp.web.AppRunner(app)
    await runner.setup()
    site = aiohttp.web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    try:
        port = site._server.sockets[0].getsockname()[1]
        async with aiohttp.ClientSession() as session:
            async with session.get(f'http://127.0.0.1:{port}/') as response:
                if await response.text() != 'native-http-ok':
                    raise SystemExit('actual aiohttp loopback round trip failed')
    finally:
        await runner.cleanup()
asyncio.run(roundtrip())
key = asyncssh.generate_private_key('ssh-ed25519')
public = asyncssh.import_public_key(key.export_public_key())
signature = key.sign(b'local-security-proof', b'ssh-ed25519')
if not public.verify(b'local-security-proof', signature):
    raise SystemExit('actual AsyncSSH signature round trip failed')
cleaned = Cleaner(scripts=True).clean_html('<div><script>unsafe()</script><p>native-xml-ok</p></div>')
if '<script' in cleaned or 'native-xml-ok' not in cleaned:
    raise SystemExit('actual lxml cleaner failed')
if etree.fromstring(b'<root><child/></root>')[0].tag != 'child':
    raise SystemExit('actual lxml native parser failed')
for fmt in ('PNG', 'JPEG', 'WEBP'):
    data = io.BytesIO()
    Image.new('RGB', (32, 24), (20, 100, 200)).save(data, format=fmt)
    data.seek(0)
    loaded = Image.open(data)
    loaded.load()
    if loaded.size != (32, 24):
        raise SystemExit('actual Pillow native codec failed')
print(json.dumps({'installed': installed, 'uv_archives': cache,
    'native': ['aiohttp-loopback', 'asyncssh-ed25519', 'lxml-parse-clean', 'Pillow-PNG-JPEG-WEBP']}))
'''
python = json.loads(run('/root/.local/share/uv/tools/kimi-cli/bin/python', ['-', json.dumps(overrides)], python_source))
print(json.dumps({'image_id': image, 'source': source, 'recipe': kind, 'cli_versions': versions, 'npm_bundled_packages': npm_dependencies,
                  'python': python, 'model_calls': 0}, indent=2))

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const repo = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const command = (program, args, cwd) => execute(program, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })

test('packed production install embeds isolated HTTP services and runs the existing binary', { timeout: 300_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'cli-bridge-package-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const packed = JSON.parse((await command(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo)).stdout)[0]
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n')
  await command(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', join(root, packed.filename)], root)
  const manifest = JSON.parse(await readFile(join(root, 'node_modules/cli-bridge/package.json'), 'utf8'))
  assert.ok(manifest.dependencies.tsx, 'the existing loader must be installed in production')
  assert.equal(manifest.devDependencies?.tsx, undefined)
  await writeFile(join(root, 'consumer.mts'), `
    import { loadConfig, startServer, type BridgeServer } from 'cli-bridge';
    const config = { ...loadConfig({ BRIDGE_DATA_DIR: './state', BRIDGE_BACKENDS: '' }), port: 0 };
    const run = async (): Promise<BridgeServer> => startServer({ config, handleSignals: false, quiet: true });
    void run;
  `)
  await command(join(repo, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', 'false',
    '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
    '--types', 'node', '--typeRoots', join(repo, 'node_modules/@types'), 'consumer.mts'], root)
  await writeFile(join(root, 'consumer.mjs'), `
    import assert from 'node:assert/strict';
    import { randomBytes } from 'node:crypto';
    import { existsSync, statSync } from 'node:fs';
    import { createServer } from 'node:net';
    import { once } from 'node:events';
    import { join } from 'node:path';
    import { loadConfig, startServer } from 'cli-bridge';
    const bearer = randomBytes(32).toString('hex');
    const events = ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException', 'unhandledRejection'];
    const before = events.map((event) => process.listeners(event));
    const open = (directory, port = 0) => startServer({ config: { ...loadConfig({
      BRIDGE_DATA_DIR: directory, BRIDGE_BACKENDS: '', BRIDGE_BEARER: bearer,
      BRIDGE_TRACE: 'off', BRIDGE_ASYNC_DURABLE_WRITES: 'true',
    }), port }, handleSignals: false, quiet: true });
    const directory = join(process.cwd(), 'state');
    const base = loadConfig({ BRIDGE_DATA_DIR: directory, BRIDGE_BACKENDS: '', BRIDGE_TRACE: 'off' });
    await assert.rejects(startServer({ config: { ...base, host: '0.0.0.0' }, handleSignals: false }), /BRIDGE_BEARER/);
    assert.equal(existsSync(directory), false);
    const partialDirectory = join(process.cwd(), 'partial');
    await assert.rejects(startServer({ config: { ...base, dataDir: partialDirectory,
      port: 0, asyncDurableWrites: true, backends: new Set(['sandbox']) },
      handleSignals: false, quiet: true }), /sandbox backend enabled/);
    assert.equal(existsSync(join(partialDirectory, '.cli-bridge-data-directory.pid')), false);
    const recoveredPartial = await open(partialDirectory);
    await recoveredPartial.close();
    const invalidListenerDirectory = join(process.cwd(), 'invalid-listener');
    await assert.rejects(startServer({ config: { ...base, port: 0, bearer,
      dataDir: invalidListenerDirectory, host: String.fromCharCode(0), asyncDurableWrites: true },
      handleSignals: false, quiet: true }));
    assert.equal(existsSync(join(invalidListenerDirectory, '.cli-bridge-data-directory.pid')), false);
    const recoveredListener = await open(invalidListenerDirectory);
    await recoveredListener.close();
    const mutable = { ...loadConfig({ BRIDGE_DATA_DIR: join(process.cwd(), 'mutable'),
      BRIDGE_BACKENDS: '', BRIDGE_BEARER: bearer, BRIDGE_ASYNC_DURABLE_WRITES: 'true', BRIDGE_TRACE: 'off' }), port: 0 };
    const starting = startServer({ config: mutable, handleSignals: false, quiet: true });
    mutable.host = '0.0.0.0'; mutable.bearer = null; mutable.backends.add('sandbox');
    const captured = await starting;
    try {
      assert.equal(new URL(captured.url).hostname, '127.0.0.1');
      assert.equal((await fetch(captured.url + '/v1/models')).status, 401);
    } finally { await captured.close(); }
    const first = await open(directory);
    const sibling = await open(join(process.cwd(), 'sibling'));
    try {
      assert.equal(new URL(first.url).hostname, '127.0.0.1');
      assert.notEqual(first.url, sibling.url);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal((await fetch(first.url + '/health')).status, 200);
      assert.equal((await fetch(first.url + '/v1/models')).status, 401);
      assert.equal((await fetch(first.url + '/v1/models', { headers: { authorization: 'Bearer ' + bearer } })).status, 200);
      await first.close();
      await first.close();
      await assert.rejects(fetch(first.url + '/health'));
      assert.equal((await fetch(sibling.url + '/health')).status, 200);
      assert.equal(existsSync(join(directory, '.cli-bridge-data-directory.pid')), false);
      const reopened = await open(directory);
      await reopened.close();
      const occupied = createServer();
      occupied.listen(0, '127.0.0.1');
      await once(occupied, 'listening');
      const refusedDirectory = join(process.cwd(), 'refused');
      try {
        await assert.rejects(open(refusedDirectory, occupied.address().port), { code: 'EADDRINUSE' });
        assert.equal(existsSync(join(refusedDirectory, '.cli-bridge-data-directory.pid')), false);
        const recovered = await open(refusedDirectory);
        await recovered.close();
      } finally { await new Promise((resolve) => occupied.close(resolve)); }
      assert.deepEqual(events.map((event) => process.listeners(event)), before);
    } finally { await first.close(); await sibling.close(); }
    process.stdout.write('packed embedding PASS\\n');
  `)
  const embedded = await command(process.execPath, [join(root, 'consumer.mjs')], root)
  assert.equal(embedded.stdout.trim(), 'packed embedding PASS')

  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((accept, reject) => listener.close((error) => error ? reject(error) : accept()))
  const state = join(root, 'standalone')
  const child = spawn(process.execPath, [join(root, 'node_modules/cli-bridge', manifest.bin['cli-bridge'])], {
    cwd: root, env: { ...process.env, BRIDGE_DATA_DIR: state, BRIDGE_BACKENDS: '',
      BRIDGE_PORT: String(port), BRIDGE_HOST: '127.0.0.1', BRIDGE_TRACE: 'off',
      BRIDGE_ASYNC_DURABLE_WRITES: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stderr.on('data', (chunk) => { diagnostics += chunk })
  const exited = once(child, 'exit')
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  })
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`packed binary did not become ready: ${diagnostics}`)), 20_000)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes(`[cli-bridge] listening on http://127.0.0.1:${port}`)) { clearTimeout(timer); accept() }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`packed binary exited ${code}: ${diagnostics}`)) })
  })
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null], diagnostics)
})

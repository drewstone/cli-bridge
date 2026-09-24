import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PiAuthResolutionError, resolvePiAuthCredential } from '../src/backends/pi-auth-credential.js'
import { createPiInferenceTransportResolver } from '../src/backends/pi-inference-transport.js'
import { BackendError } from '../src/backends/types.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('reports both failed auth helper exits and durations without command output or credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-auth-evidence-'))
  dirs.push(dir)
  const bin = join(dir, 'pi')
  const secret = 'private-auth-output-must-never-leak'
  writeFileSync(bin, [
    '#!/bin/sh',
    'test "$1" = auth',
    'test "$3" = --provider',
    'test "$4" = tangle-router',
    'test "$5" = --model',
    'test "$6" = gpt-5-mini',
    `printf %s ${JSON.stringify(secret)}`,
    `printf %s ${JSON.stringify(secret)} >&2`,
    'if [ "$2" = print-api-key ]; then exit 17; fi',
    'test "$2" = print-bearer-token',
    'exit 23',
  ].join('\n'))
  chmodSync(bin, 0o700)

  const warnings: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((message: string) => { warnings.push(message) })
  const error = await resolvePiAuthCredential({
    bin,
    provider: 'tangle-router',
    model: 'gpt-5-mini',
    apiMode: 'openai-completions',
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  }).catch((failure: unknown) => failure)

  expect(error).toBeInstanceOf(PiAuthResolutionError)
  if (!(error instanceof PiAuthResolutionError)) throw new Error('expected PiAuthResolutionError')
  expect(error).toMatchObject({
    backendCode: 'upstream',
    attempts: [
      { command: 'print-api-key', outcome: 'exit', exitCode: 17 },
      { command: 'print-bearer-token', outcome: 'exit', exitCode: 23 },
    ],
  })
  expect(error.message).toMatch(/id=[a-f0-9-]+.*print-api-key.*exit_code=17.*elapsed_ms=\d+.*print-bearer-token.*exit_code=23.*elapsed_ms=\d+/u)
  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toContain('command=print-api-key outcome=exit exit_code=17 elapsed_ms=')
  expect(warnings[1]).toContain('command=print-bearer-token outcome=exit exit_code=23 elapsed_ms=')
  expect(`${error.message}\n${warnings.join('\n')}`).not.toContain(secret)

  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    providers: {
      'tangle-router': {
        baseUrl: 'https://router.tangle.tools/v1',
        api: 'openai-completions',
        models: [{ id: 'gpt-5-mini', maxTokens: 4_096 }],
      },
    },
  }))
  const resolver = createPiInferenceTransportResolver({
    bin,
    agentDir: dir,
    sessionDir: join(dir, 'sessions'),
    env: { PATH: process.env.PATH },
  })
  const diagnosticId = '82f7e59a-3950-440f-9f19-03981575c0f1'
  const backendError = await resolver(
    { provider: 'tangle-router', model: 'gpt-5-mini' },
    new AbortController().signal,
    undefined,
    diagnosticId,
  ).catch((failure: unknown) => failure)
  expect(backendError).toBeInstanceOf(BackendError)
  if (!(backendError instanceof BackendError)) throw new Error('expected BackendError')
  expect(backendError.code).toBe('upstream')
  expect(backendError.message).toContain(`id=${diagnosticId}`)
  expect(backendError.message).toContain('print-api-key')
  expect(backendError.message).toContain('print-bearer-token')
  expect(backendError.message).not.toContain(secret)
  expect(warnings.slice(2).every((message) => message.includes(`id=${diagnosticId}`))).toBe(true)

  const injectedId = 'secret\nforged-log'
  const rejectedIdError = await resolvePiAuthCredential({
    bin,
    provider: 'tangle-router',
    model: 'gpt-5-mini',
    apiMode: 'openai-completions',
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    diagnosticId: injectedId,
  }).catch((failure: unknown) => failure)
  expect(rejectedIdError).toBeInstanceOf(PiAuthResolutionError)
  if (!(rejectedIdError instanceof PiAuthResolutionError)) throw new Error('expected PiAuthResolutionError')
  expect(`${rejectedIdError.message}\n${warnings.slice(4).join('\n')}`).not.toContain('forged-log')
  expect(rejectedIdError.diagnosticId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u)

  const deadline = new AbortController()
  deadline.abort(Object.assign(new Error('deadline detail must stay private'), { code: 'timeout' }))
  const timeoutError = await resolvePiAuthCredential({
    bin,
    provider: 'tangle-router',
    model: 'gpt-5-mini',
    apiMode: 'openai-completions',
    env: { PATH: process.env.PATH },
    signal: deadline.signal,
  }).catch((failure: unknown) => failure)
  expect(timeoutError).toBeInstanceOf(PiAuthResolutionError)
  if (!(timeoutError instanceof PiAuthResolutionError)) throw new Error('expected PiAuthResolutionError')
  expect(timeoutError.backendCode).toBe('timeout')
  expect(timeoutError.attempts).toMatchObject([{ command: 'print-api-key', outcome: 'timeout' }])
  expect(timeoutError.message).not.toContain('deadline detail must stay private')
})

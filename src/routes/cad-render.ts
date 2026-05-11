/**
 * POST /cad/render — OpenSCAD source → STL/PNG/GLB.
 *
 * Generic CAD render endpoint. physim is the first consumer (chicken
 * coops, sensor enclosures, jigs), but any caller that needs to
 * rasterize parametric SCAD can use this — the route makes no physim
 * assumptions. Inputs are the OpenSCAD source text, the desired output
 * formats, and optional render hints; outputs are base64-encoded
 * artifact bytes plus warnings from openscad's stderr.
 *
 * Implementation notes:
 *   - `openscad` is expected on $PATH. In our usual setup it comes from
 *     the `hardware` profile in `tangle-network/agent-dev-container`
 *     (which also vendors `python` + `trimesh` for the GLB step). If
 *     the binary isn't present, the endpoint returns
 *     `{ok: false, error: "openscad not found on $PATH"}` rather than
 *     crashing the process.
 *   - GLB conversion uses `python -c "import trimesh; ..."` when
 *     available. If python or trimesh isn't installed (e.g. cli-bridge
 *     running outside the nix env), we emit a warning and omit `glb`
 *     from `artifacts` — never crash.
 *   - Each artifact is capped at 10MB after base64 encoding to keep
 *     responses size-bounded; the OpenSCAD output is checked at read
 *     time (before encoding) against the same byte budget. Larger
 *     outputs short-circuit with a clean error rather than thrashing.
 *   - Wall-clock timeout via `CAD_RENDER_TIMEOUT_MS` (default 60_000).
 *     The whole pipeline (stl + png + glb) shares the budget; on
 *     timeout we kill the in-flight subprocess and return ok:false.
 *   - Tempdir is removed in `finally` regardless of outcome.
 */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 // 10MB

const cadRenderSchema = z.object({
  code: z.string().min(1, 'code must be a non-empty OpenSCAD source string'),
  outputs: z
    .array(z.enum(['stl', 'png', 'glb']))
    .min(1)
    .optional(),
  imageSize: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  defines: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
})

type CadRenderRequest = z.infer<typeof cadRenderSchema>

interface ArtifactBytes {
  bytes: number
  base64: string
}

interface SuccessBody {
  ok: true
  artifacts: {
    stl?: ArtifactBytes
    png?: ArtifactBytes
    glb?: ArtifactBytes
  }
  durationMs: number
  warnings: string[]
}

interface FailureBody {
  ok: false
  error: string
  durationMs: number
}

export function mountCadRender(app: Hono): void {
  app.post('/cad/render', async (c) => {
    const startedAt = Date.now()

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
        400,
      )
    }

    const parsed = cadRenderSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: 'invalid cad render request',
            type: 'invalid_request_error',
            details: parsed.error.flatten(),
          },
        },
        422,
      )
    }

    const outputs = parsed.data.outputs ?? ['stl', 'png']
    const timeoutMs = resolveTimeoutMs()
    const deadline = startedAt + timeoutMs

    let tmpRoot: string | null = null
    try {
      tmpRoot = await mkdtemp(join(tmpdir(), 'cli-bridge-cad-'))
      const scadPath = join(tmpRoot, 'model.scad')
      await writeFile(scadPath, parsed.data.code, 'utf8')

      const warnings: string[] = []
      const artifacts: SuccessBody['artifacts'] = {}
      const defineArgs = buildDefineArgs(parsed.data.defines)
      const imageSize = parsed.data.imageSize ?? [800, 600]

      // STL must come first when GLB is requested — trimesh reads STL to
      // produce GLB. PNG is independent.
      const needsStl = outputs.includes('stl') || outputs.includes('glb')
      if (needsStl) {
        const stlPath = join(tmpRoot, 'out.stl')
        const stlResult = await runOpenscad(
          ['-o', stlPath, ...defineArgs, scadPath],
          deadline,
        )
        if (stlResult.kind === 'error') {
          return c.json<FailureBody>(
            { ok: false, error: stlResult.message, durationMs: Date.now() - startedAt },
            200,
          )
        }
        if (stlResult.stderr) warnings.push(`openscad stl: ${stlResult.stderr}`)
        if (outputs.includes('stl')) {
          const loaded = await loadArtifact(stlPath)
          if (loaded.kind === 'too_large') {
            return c.json<FailureBody>(
              {
                ok: false,
                error: `stl artifact too large: ${loaded.bytes} bytes exceeds ${MAX_ARTIFACT_BYTES}`,
                durationMs: Date.now() - startedAt,
              },
              200,
            )
          }
          artifacts.stl = loaded.artifact
        }

        if (outputs.includes('glb')) {
          const glbPath = join(tmpRoot, 'out.glb')
          const glbResult = await runStlToGlb(stlPath, glbPath, deadline)
          if (glbResult.kind === 'unavailable') {
            warnings.push(
              `glb requested but unavailable (${glbResult.reason}) — install python + trimesh, or omit "glb" from outputs`,
            )
          } else if (glbResult.kind === 'error') {
            warnings.push(`glb conversion failed: ${glbResult.message}`)
          } else {
            const loaded = await loadArtifact(glbPath)
            if (loaded.kind === 'too_large') {
              return c.json<FailureBody>(
                {
                  ok: false,
                  error: `glb artifact too large: ${loaded.bytes} bytes exceeds ${MAX_ARTIFACT_BYTES}`,
                  durationMs: Date.now() - startedAt,
                },
                200,
              )
            }
            artifacts.glb = loaded.artifact
          }
        }
      }

      if (outputs.includes('png')) {
        const pngPath = join(tmpRoot, 'out.png')
        const pngResult = await runOpenscad(
          [
            '-o',
            pngPath,
            `--imgsize=${imageSize[0]},${imageSize[1]}`,
            ...defineArgs,
            scadPath,
          ],
          deadline,
        )
        if (pngResult.kind === 'error') {
          return c.json<FailureBody>(
            { ok: false, error: pngResult.message, durationMs: Date.now() - startedAt },
            200,
          )
        }
        if (pngResult.stderr) warnings.push(`openscad png: ${pngResult.stderr}`)
        const loaded = await loadArtifact(pngPath)
        if (loaded.kind === 'too_large') {
          return c.json<FailureBody>(
            {
              ok: false,
              error: `png artifact too large: ${loaded.bytes} bytes exceeds ${MAX_ARTIFACT_BYTES}`,
              durationMs: Date.now() - startedAt,
            },
            200,
          )
        }
        artifacts.png = loaded.artifact
      }

      const body: SuccessBody = {
        ok: true,
        artifacts,
        durationMs: Date.now() - startedAt,
        warnings,
      }
      return c.json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(c, message, Date.now() - startedAt)
    } finally {
      if (tmpRoot) {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
      }
    }
  })
}

function resolveTimeoutMs(): number {
  const raw = Number(process.env.CAD_RENDER_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

function buildDefineArgs(defines: CadRenderRequest['defines']): string[] {
  if (!defines) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(defines)) {
    // openscad's -D accepts `name=value` where strings need to be
    // quoted, numbers/booleans are bare. JSON.stringify gives us the
    // right shape for strings (with quotes) AND for numbers/booleans
    // (bare literals).
    out.push('-D', `${k}=${JSON.stringify(v)}`)
  }
  return out
}

type OpenscadResult =
  | { kind: 'ok'; stderr: string }
  | { kind: 'error'; message: string }

async function runOpenscad(args: string[], deadline: number): Promise<OpenscadResult> {
  return runSubprocess('openscad', args, deadline, 'openscad')
}

type StlToGlbResult =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; reason: string }

async function runStlToGlb(stlPath: string, glbPath: string, deadline: number): Promise<StlToGlbResult> {
  // One-shot python script — keep the body tiny so an inline -c is
  // legible. trimesh handles STL → GLB natively via export().
  const script = `import sys, trimesh; m = trimesh.load(sys.argv[1]); m.export(sys.argv[2])`
  const result = await runSubprocess(
    'python3',
    ['-c', script, stlPath, glbPath],
    deadline,
    'python3',
  )
  if (result.kind === 'ok') return { kind: 'ok' }
  // Distinguish "binary missing" from "binary ran but failed". ENOENT
  // / "not found" / ModuleNotFoundError all map to unavailable so the
  // caller knows to install rather than re-try.
  const message = result.message
  if (
    message.includes('ENOENT') ||
    message.includes('not found') ||
    message.includes('No module named')
  ) {
    return { kind: 'unavailable', reason: message }
  }
  return { kind: 'error', message }
}

async function runSubprocess(
  bin: string,
  args: string[],
  deadline: number,
  label: string,
): Promise<OpenscadResult> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    return { kind: 'error', message: `${label} timed out before start` }
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      resolve({ kind: 'error', message: `${label} spawn failed: ${message}` })
      return
    }

    const stderrChunks: Buffer[] = []
    const stdoutChunks: Buffer[] = []
    let settled = false

    const settle = (result: OpenscadResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ kind: 'error', message: `${label} timed out after ${remainingMs}ms` })
    }, remainingMs)

    child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b))
    child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b))
    child.on('error', (err) => {
      settle({ kind: 'error', message: `${label} failed: ${err.message}` })
    })
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      if (code === 0) {
        settle({ kind: 'ok', stderr })
      } else {
        const detail = stderr || Buffer.concat(stdoutChunks).toString('utf8').trim() || `exit ${code}`
        settle({ kind: 'error', message: `${label} exit ${code}: ${detail}` })
      }
    })
  })
}

type LoadedArtifact =
  | { kind: 'ok'; artifact: ArtifactBytes }
  | { kind: 'too_large'; bytes: number }

async function loadArtifact(path: string): Promise<LoadedArtifact> {
  const buf = await readFile(path)
  if (buf.byteLength > MAX_ARTIFACT_BYTES) {
    return { kind: 'too_large', bytes: buf.byteLength }
  }
  return {
    kind: 'ok',
    artifact: { bytes: buf.byteLength, base64: buf.toString('base64') },
  }
}

function errorResponse(c: Context, message: string, durationMs: number): Response {
  const body: FailureBody = { ok: false, error: message, durationMs }
  return c.json(body, 500)
}

import { serve } from '@hono/node-server'
import { anyBackendSpawnsOnHost, loadConfig } from '../config.js'
import { DockerPreflightError } from '../executors/docker-preflight.js'
import { selectJailBackend } from '../jail/index.js'
import { acquireInstanceLock, DataDirectoryInUseError } from '../runtime/single-instance.js'
import { reapStalePrivateTemporaryRoots } from '../runtime/private-temporary.js'
import { buildApp } from './app.js'
import { parseEnvPositiveInt } from './executors.js'
import type { StartServerOptions } from './types.js'

export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const config = loadConfig()

  // Acquire the durable-data writer lock before opening sessions.sqlite.
  // Different ports do not make concurrent writers safe.
  let instanceLock
  try {
    instanceLock = acquireInstanceLock({ port: config.port, dataDir: config.dataDir })
    reapStalePrivateTemporaryRoots()
  } catch (err) {
    if (err instanceof DataDirectoryInUseError) {
      console.error(`[cli-bridge] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  let built
  try {
    built = await buildApp(config)
  } catch (err) {
    // A preflight failure is an operator message, not a stack trace: it already
    // contains the observation and the command that fixes it.
    if (err instanceof DockerPreflightError) {
      console.error(`[cli-bridge] FATAL: ${err.message}`)
      instanceLock.release()
      process.exit(1)
    }
    instanceLock.release()
    throw err
  }
  const { app, sessions, runs, extras } = built
  extras.shutdownHooks.push(...(options.shutdownHooks ?? []))
  // Drop the lock on hard exit too — graceful shutdown also releases, but
  // a process.exit() path (fatal error) must not strand the pidfile.
  process.once('exit', () => instanceLock.release())
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
      // Pass timeouts at create-time so they apply to the http.Server
      // before it starts accepting. Setting them post-listen has the
      // same effect for new sockets, but doing it here is bulletproof.
      serverOptions: {
        requestTimeout: 0,
        headersTimeout: 0,
        keepAliveTimeout: 0,
      },
    },
    (info) => {
      console.log(`[cli-bridge] listening on http://${info.address}:${info.port}  (host=${config.host})`)
      console.log(`[cli-bridge] backends: ${[...config.backends].join(', ')}`)
      console.log(`[cli-bridge] bearer: ${config.bearer ? 'required' : 'none (loopback only)'}`)
      console.log(
        `[cli-bridge] host admission: maxActive=${config.admission.maxActive} maxQueue=${config.admission.maxQueue} queueTimeoutMs=${config.admission.queueTimeoutMs}`,
      )
      console.log(
        config.trace.enabled
          ? `[cli-bridge] traces: ${config.trace.file} (max ${config.trace.maxBytes} bytes × ${config.trace.maxFiles} files)`
          : '[cli-bridge] traces: off (BRIDGE_TRACE=off)',
      )
      // WORKER_FS_JAIL=1 is a shorthand that raises the operator jail floor to
      // fs-jail even when BRIDGE_JAIL_MODE is unset, so fold it into the effective
      // floor the startup gate + log report.
      const fsJailFlag = ['1', 'true', 'yes', 'on'].includes((process.env.WORKER_FS_JAIL ?? '').trim().toLowerCase())
      const jailFloor: 'off' | 'write-jail' | 'fs-jail' = fsJailFlag ? 'fs-jail' : config.jailMode
      console.log(
        `[cli-bridge] jail default: ${jailFloor}${jailFloor !== 'off' ? ` root=${config.jailRoot ?? '<cwd>/.agent-home'}` : ''}`,
      )
      // Fail fast (don't go ready) if a jail is the operator floor but no jail
      // backend can run here — every host request would otherwise fail closed while
      // /health reports ready. Only relevant when some backend actually spawns on the
      // host: docker/remote-only deployments never hit the host jail. Honor
      // BRIDGE_JAIL_FALLBACK=warn, which runs unconfined-with-warning instead.
      const hasHostSpawn = anyBackendSpawnsOnHost(config.backends, config.executors)
      if (jailFloor !== 'off' && hasHostSpawn && !selectJailBackend().isAvailable()) {
        if (process.env.BRIDGE_JAIL_FALLBACK === 'warn') {
          console.warn(
            `[cli-bridge] WARNING: jail floor '${jailFloor}' set but no jail backend can run here; ` +
              'requests run UNCONFINED (BRIDGE_JAIL_FALLBACK=warn).',
          )
        } else {
          console.error(
            `[cli-bridge] FATAL: jail floor '${jailFloor}' set but no jail backend can run on this ` +
              'host — every host request would fail closed. Enable unprivileged user namespaces (Linux: ' +
              '`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or `sudo chmod u+s /usr/bin/bwrap`), ' +
              'ensure sandbox-exec exists (macOS), set BRIDGE_JAIL_FALLBACK=warn, or unset the jail floor.',
          )
          void shutdown('fatal jail configuration', 1)
        }
      }
      for (const cfg of Object.values(config.executors)) {
        if (cfg.kind === 'docker') {
          console.log(`[cli-bridge] ${cfg.name} executor: docker pool size=${cfg.poolSize} image=${cfg.image}`)
        }
      }
    },
  )
  // Node's http server defaults requestTimeout=300_000 (5 min). Long
  // audit runs that stream tool_use deltas for 10–30 min get severed
  // mid-flight by that ceiling; without this bump every long run dies
  // at 300_700ms and the caller sees a truncated SSE stream with no
  // final stop event. 0 = no per-request ceiling — the per-backend
  // CLI_TIMEOUT_MS still bounds the underlying subprocess.
  ;(server as { requestTimeout?: number }).requestTimeout = 0
  ;(server as { headersTimeout?: number }).headersTimeout = 0
  const connectionCloser = server as typeof server & {
    closeAllConnections?: () => void
    closeIdleConnections?: () => void
  }

  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? parseEnvPositiveInt('BRIDGE_SHUTDOWN_TIMEOUT_MS', 5_000)
  let shutdownPromise: Promise<void> | null = null
  const shutdown = (sig: string, requestedExitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    const deadlineAt = Date.now() + shutdownTimeoutMs
    let exiting = false
    let localResourcesClosed = false
    const failures: unknown[] = []
    const closeLocalResources = (): void => {
      if (localResourcesClosed) return
      localResourcesClosed = true
      try {
        connectionCloser.closeAllConnections?.()
      } catch (error) {
        failures.push(error)
      }
      try {
        sessions.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        instanceLock.release()
      } catch (error) {
        failures.push(error)
      }
    }
    const exit = (code: number): void => {
      if (exiting) return
      exiting = true
      closeLocalResources()
      process.exit(code)
    }
    const deadlineTimer = setTimeout(() => {
      failures.push(new Error(`shutdown exceeded ${shutdownTimeoutMs}ms`))
      console.error(`[cli-bridge] ${sig} shutdown deadline reached after ${shutdownTimeoutMs}ms`)
      exit(1)
    }, shutdownTimeoutMs)

    const runWithBudget = async (operation: Promise<void>, budgetMs: number, label: string): Promise<void> => {
      if (budgetMs <= 0) throw new Error(`${label} had no shutdown time remaining`)
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${budgetMs}ms shutdown budget`)), budgetMs)
      })
      try {
        await Promise.race([operation, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    shutdownPromise = (async () => {
      console.log(`[cli-bridge] ${sig} — shutting down`)
      runs.closeAdmission()
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      connectionCloser.closeIdleConnections?.()

      try {
        const remaining = Math.max(1, deadlineAt - Date.now())
        const runBudget = Math.max(1, Math.floor(remaining * 0.8))
        await runWithBudget(runs.shutdown(runBudget), runBudget, 'run cleanup')
      } catch (error) {
        failures.push(error)
      }

      for (let index = 0; index < extras.shutdownHooks.length; index += 1) {
        const hook = extras.shutdownHooks[index]
        const hooksLeft = extras.shutdownHooks.length - index
        const remaining = deadlineAt - Date.now()
        const hookBudget = Math.max(1, Math.floor(remaining / Math.max(1, hooksLeft)))
        try {
          await runWithBudget(Promise.resolve().then(hook), hookBudget, `shutdown hook ${index + 1}`)
        } catch (error) {
          failures.push(error)
        }
      }

      try {
        // Active streaming and incomplete HTTP requests can otherwise keep
        // http.Server.close() pending forever after all owned work is gone.
        connectionCloser.closeAllConnections?.()
        const remaining = Math.max(1, deadlineAt - Date.now())
        await runWithBudget(serverClosed, remaining, 'HTTP connection cleanup')
      } catch (error) {
        failures.push(error)
      }

      clearTimeout(deadlineTimer)
      closeLocalResources()
      if (failures.length > 0) {
        console.error(`[cli-bridge] shutdown completed with ${failures.length} cleanup failure(s)`, failures)
      }
      exit(requestedExitCode === 0 && failures.length === 0 ? 0 : 1)
    })()
    return shutdownPromise
  }
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  // An error that escaped every request boundary means process invariants are
  // unknown. Stop accepting work, terminate owned children, flush cleanup, and
  // exit non-zero so a supervisor can restart from durable state.
  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error('[cli-bridge] unhandledRejection — initiating fatal shutdown', {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
      promise: String(promise).slice(0, 120),
    })
    void shutdown('unhandledRejection', 1)
  })
  process.on('uncaughtException', (err) => {
    console.error('[cli-bridge] uncaughtException — initiating fatal shutdown', {
      message: err.message,
      name: err.name,
      code: (err as NodeJS.ErrnoException).code,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    })
    void shutdown('uncaughtException', 1)
  })
}

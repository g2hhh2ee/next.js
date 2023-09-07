#!/usr/bin/env node
import arg from 'next/dist/compiled/arg/index.js'
import type { StartServerOptions } from '../server/lib/start-server'
import {
  genRouterWorkerExecArgv,
  getNodeOptionsWithoutInspect,
} from '../server/lib/utils'
import { getPort, printAndExit } from '../server/lib/utils'
import * as Log from '../build/output/log'
import { CliCommand } from '../lib/commands'
import { getProjectDir } from '../lib/get-project-dir'
import { CONFIG_FILES, PHASE_DEVELOPMENT_SERVER } from '../shared/lib/constants'
import path from 'path'
import { NextConfigComplete } from '../server/config-shared'
import { setGlobal, traceGlobals } from '../trace/shared'
import { Telemetry } from '../telemetry/storage'
import loadConfig, { getEnabledExperimentalFeatures } from '../server/config'
import { findPagesDir } from '../lib/find-pages-dir'
import { fileExists, FileType } from '../lib/file-exists'
import { getNpxCommand } from '../lib/helpers/get-npx-command'
import Watchpack from 'watchpack'
import { initialEnv } from '@next/env'
import { getValidatedArgs } from '../lib/get-validated-args'
import { Worker } from 'next/dist/compiled/jest-worker'
import type { ChildProcess } from 'child_process'
import { checkIsNodeDebugging } from '../server/lib/is-node-debugging'
import { createSelfSignedCertificate } from '../lib/mkcert'
import uploadTrace from '../trace/upload-trace'
import { loadEnvConfig } from '@next/env'
import { trace } from '../trace'
import { validateTurboNextConfig } from '../lib/turbopack-warning'

let dir: string
let config: NextConfigComplete
let isTurboSession = false
let traceUploadUrl: string
let sessionStopHandled = false
let sessionStarted = Date.now()

const handleSessionStop = async () => {
  if (sessionStopHandled) return
  sessionStopHandled = true

  try {
    const { eventCliSessionStopped } =
      require('../telemetry/events/session-stopped') as typeof import('../telemetry/events/session-stopped')

    config =
      config ||
      (await loadConfig(
        PHASE_DEVELOPMENT_SERVER,
        dir,
        undefined,
        undefined,
        true
      ))

    let telemetry =
      (traceGlobals.get('telemetry') as InstanceType<
        typeof import('../telemetry/storage').Telemetry
      >) ||
      new Telemetry({
        distDir: path.join(dir, config.distDir),
      })

    let pagesDir: boolean = !!traceGlobals.get('pagesDir')
    let appDir: boolean = !!traceGlobals.get('appDir')

    if (
      typeof traceGlobals.get('pagesDir') === 'undefined' ||
      typeof traceGlobals.get('appDir') === 'undefined'
    ) {
      const pagesResult = findPagesDir(dir)
      appDir = !!pagesResult.appDir
      pagesDir = !!pagesResult.pagesDir
    }

    telemetry.record(
      eventCliSessionStopped({
        cliCommand: 'dev',
        turboFlag: isTurboSession,
        durationMilliseconds: Date.now() - sessionStarted,
        pagesDir,
        appDir,
      }),
      true
    )
    telemetry.flushDetached('dev', dir)
  } catch (_) {
    // errors here aren't actionable so don't add
    // noise to the output
  }

  if (traceUploadUrl) {
    uploadTrace({
      traceUploadUrl,
      mode: 'dev',
      isTurboSession,
      projectDir: dir,
      distDir: config.distDir,
    })
  }

  // ensure we re-enable the terminal cursor before exiting
  // the program, or the cursor could remain hidden
  process.stdout.write('\x1B[?25h')
  process.stdout.write('\n')
  process.exit(0)
}

process.on('SIGINT', handleSessionStop)
process.on('SIGTERM', handleSessionStop)

function watchConfigFiles(
  dirToWatch: string,
  onChange: (filename: string) => void
) {
  const wp = new Watchpack()
  wp.watch({ files: CONFIG_FILES.map((file) => path.join(dirToWatch, file)) })
  wp.on('change', onChange)
}

type StartServerWorker = Worker &
  Pick<typeof import('../server/lib/start-server'), 'startServer'>

async function createRouterWorker(fullConfig: NextConfigComplete): Promise<{
  worker: StartServerWorker
  cleanup: () => Promise<void>
}> {
  const isNodeDebugging = checkIsNodeDebugging()
  const worker = new Worker(require.resolve('../server/lib/start-server'), {
    numWorkers: 1,
    // TODO: do we want to allow more than 8 OOM restarts?
    maxRetries: 8,
    forkOptions: {
      execArgv: await genRouterWorkerExecArgv(
        isNodeDebugging === undefined ? false : isNodeDebugging
      ),
      env: {
        FORCE_COLOR: '1',
        ...(initialEnv as any),
        NODE_OPTIONS: getNodeOptionsWithoutInspect(),
        ...(process.env.NEXT_CPU_PROF
          ? { __NEXT_PRIVATE_CPU_PROFILE: `CPU.router` }
          : {}),
        WATCHPACK_WATCHER_LIMIT: '20',
        TURBOPACK: process.env.TURBOPACK,
        __NEXT_PRIVATE_PREBUNDLED_REACT: !!fullConfig.experimental.serverActions
          ? 'experimental'
          : 'next',
      },
    },
    exposedMethods: ['startServer'],
  }) as Worker &
    Pick<typeof import('../server/lib/start-server'), 'startServer'>

  const cleanup = () => {
    for (const curWorker of ((worker as any)._workerPool?._workers || []) as {
      _child?: ChildProcess
    }[]) {
      curWorker._child?.kill('SIGINT')
    }
    process.exit(0)
  }

  // If the child routing worker exits we need to exit the entire process
  for (const curWorker of ((worker as any)._workerPool?._workers || []) as {
    _child?: ChildProcess
  }[]) {
    curWorker._child?.on('exit', cleanup)
  }

  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('uncaughtException', cleanup)
  process.on('unhandledRejection', cleanup)

  const workerStdout = worker.getStdout()
  const workerStderr = worker.getStderr()

  workerStdout.on('data', (data) => {
    process.stdout.write(data)
  })
  workerStderr.on('data', (data) => {
    process.stderr.write(data)
  })

  return {
    worker,
    cleanup: async () => {
      // Remove process listeners for childprocess too.
      for (const curWorker of ((worker as any)._workerPool?._workers || []) as {
        _child?: ChildProcess
      }[]) {
        curWorker._child?.off('exit', cleanup)
      }
      process.off('exit', cleanup)
      process.off('SIGINT', cleanup)
      process.off('SIGTERM', cleanup)
      process.off('uncaughtException', cleanup)
      process.off('unhandledRejection', cleanup)
      await worker.end()
    },
  }
}

const nextDev: CliCommand = async (argv) => {
  const validArgs: arg.Spec = {
    // Types
    '--help': Boolean,
    '--port': Number,
    '--hostname': String,
    '--turbo': Boolean,
    '--experimental-turbo': Boolean,
    '--experimental-https': Boolean,
    '--experimental-https-key': String,
    '--experimental-https-cert': String,
    '--experimental-test-proxy': Boolean,
    '--experimental-upload-trace': String,

    // To align current messages with native binary.
    // Will need to adjust subcommand later.
    '--show-all': Boolean,
    '--root': String,

    // Aliases
    '-h': '--help',
    '-p': '--port',
    '-H': '--hostname',
  }
  const args = getValidatedArgs(validArgs, argv)
  if (args['--help']) {
    console.log(`
      Description
        Starts the application in development mode (hot-code reloading, error
        reporting, etc.)

      Usage
        $ next dev <dir> -p <port number>

      <dir> represents the directory of the Next.js application.
      If no directory is provided, the current directory will be used.

      Options
        --port, -p      A port number on which to start the application
        --hostname, -H  Hostname on which to start the application (default: 0.0.0.0)
        --experimental-upload-trace=<trace-url>  [EXPERIMENTAL] Report a subset of the debugging trace to a remote http url. Includes sensitive data. Disabled by default and url must be provided.
        --help, -h      Displays this message
    `)
    process.exit(0)
  }
  dir = getProjectDir(process.env.NEXT_PRIVATE_DEV_DIR || args._[0])

  // Check if pages dir exists and warn if not
  if (!(await fileExists(dir, FileType.Directory))) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  async function preflight(skipOnReboot: boolean) {
    const { getPackageVersion, getDependencies } = (await Promise.resolve(
      require('../lib/get-package-version')
    )) as typeof import('../lib/get-package-version')

    const [sassVersion, nodeSassVersion] = await Promise.all([
      getPackageVersion({ cwd: dir, name: 'sass' }),
      getPackageVersion({ cwd: dir, name: 'node-sass' }),
    ])
    if (sassVersion && nodeSassVersion) {
      Log.warn(
        'Your project has both `sass` and `node-sass` installed as dependencies, but should only use one or the other. ' +
          'Please remove the `node-sass` dependency from your project. ' +
          ' Read more: https://nextjs.org/docs/messages/duplicate-sass'
      )
    }

    if (!skipOnReboot) {
      const { dependencies, devDependencies } = await getDependencies({
        cwd: dir,
      })

      // Warn if @next/font is installed as a dependency. Ignore `workspace:*` to not warn in the Next.js monorepo.
      if (
        dependencies['@next/font'] ||
        (devDependencies['@next/font'] &&
          devDependencies['@next/font'] !== 'workspace:*')
      ) {
        const command = getNpxCommand(dir)
        Log.warn(
          'Your project has `@next/font` installed as a dependency, please use the built-in `next/font` instead. ' +
            'The `@next/font` package will be removed in Next.js 14. ' +
            `You can migrate by running \`${command} @next/codemod@latest built-in-next-font .\`. Read more: https://nextjs.org/docs/messages/built-in-next-font`
        )
      }
    }
  }

  const port = getPort(args)
  // If neither --port nor PORT were specified, it's okay to retry new ports.
  const allowRetry =
    args['--port'] === undefined && process.env.PORT === undefined

  // We do not set a default host value here to prevent breaking
  // some set-ups that rely on listening on other interfaces
  const host = args['--hostname']

  const { loadedEnvFiles } = loadEnvConfig(dir, true, console, false)

  let expFeatureInfo: string[] = []
  config = await loadConfig(
    PHASE_DEVELOPMENT_SERVER,
    dir,
    undefined,
    undefined,
    undefined,
    (userConfig) => {
      const userNextConfigExperimental = getEnabledExperimentalFeatures(
        userConfig.experimental
      )
      expFeatureInfo = userNextConfigExperimental.sort(
        (a, b) => a.length - b.length
      )
    }
  )

  let envInfo: string[] = []
  if (loadedEnvFiles.length > 0) {
    envInfo = loadedEnvFiles.map((f) => f.path)
  }

  const isExperimentalTestProxy = args['--experimental-test-proxy']

  if (args['--experimental-upload-trace']) {
    traceUploadUrl = args['--experimental-upload-trace']
  }

  const devServerOptions: StartServerOptions = {
    dir,
    port,
    allowRetry,
    isDev: true,
    hostname: host,
    isExperimentalTestProxy,
    envInfo,
    expFeatureInfo,
  }

  if (args['--turbo']) {
    process.env.TURBOPACK = '1'
    await validateTurboNextConfig({
      isCustomTurbopack: !!process.env.__INTERNAL_CUSTOM_TURBOPACK_BINDINGS,
      ...devServerOptions,
      isDev: true,
    })
  }

  const distDir = path.join(dir, config.distDir ?? '.next')
  setGlobal('phase', PHASE_DEVELOPMENT_SERVER)
  setGlobal('distDir', distDir)

  const runDevServer = async (reboot: boolean) => {
    try {
      const workerInit = await createRouterWorker(config)

      if (!!args['--experimental-https']) {
        Log.warn(
          'Self-signed certificates are currently an experimental feature, use at your own risk.'
        )

        let certificate: { key: string; cert: string } | undefined

        if (
          args['--experimental-https-key'] &&
          args['--experimental-https-cert']
        ) {
          certificate = {
            key: path.resolve(args['--experimental-https-key']),
            cert: path.resolve(args['--experimental-https-cert']),
          }
        } else {
          certificate = await createSelfSignedCertificate(host)
        }

        await workerInit.worker.startServer({
          ...devServerOptions,
          selfSignedCertificate: certificate,
        })
      } else {
        await workerInit.worker.startServer(devServerOptions)
      }

      await preflight(reboot)
      return {
        cleanup: workerInit.cleanup,
      }
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  }

  let runningServer: Awaited<ReturnType<typeof runDevServer>> | undefined

  watchConfigFiles(devServerOptions.dir, async (filename) => {
    if (process.env.__NEXT_DISABLE_MEMORY_WATCHER) {
      Log.info(
        `Detected change, manual restart required due to '__NEXT_DISABLE_MEMORY_WATCHER' usage`
      )
      return
    }
    // Adding a new line to avoid the logs going directly after the spinner in `next build`
    Log.warn('')
    Log.warn(
      `Found a change in ${path.basename(
        filename
      )}. Restarting the server to apply the changes...`
    )

    try {
      if (runningServer) {
        await runningServer.cleanup()
      }
      runningServer = await runDevServer(true)
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  })

  await trace('start-dev-server').traceAsyncFn(async (_) => {
    runningServer = await runDevServer(false)
  })
}

export { nextDev }

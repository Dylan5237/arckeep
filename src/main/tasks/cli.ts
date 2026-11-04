/**
 * Arckeep task engine CLI. Runs the same engine as the desktop app so real
 * Codex/Claude turns, wait events and decisions can be verified from a shell.
 *
 * Usage:
 *   node out/main/tasks/cli.js status
 *   node out/main/tasks/cli.js create --goal "..." --cwd "C:\\work\\x" --repo owner/x --agent codex --autonomy edit
 *   node out/main/tasks/cli.js watch --id <task-id> --timeout 900
 *   node out/main/tasks/cli.js reply --decision <id> --option A --note "..."
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskEngine } from './engine.js'
import { detectAgents } from './agent-detect.js'
import { runAgentProcess } from './agent-runner.js'
import { observeGithubWait } from './github-events.js'

interface ParsedArgs {
  command: string
  values: Map<string, string>
  flags: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'status'
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const body = argument.slice(2)
    if (body.startsWith('no-')) {
      flags.add(body)
      continue
    }
    const equals = body.indexOf('=')
    if (equals >= 0) {
      values.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(body, next)
      index += 1
    } else {
      flags.add(body)
    }
  }
  return { command, values, flags }
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values.get(key)
  if (!value) throw new Error('缺少 --' + key)
  return value
}

function defaultDataDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Arckeep')
}

function githubToken(): Promise<string | null> {
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
    return Promise.resolve(token || null)
  } catch {
    return Promise.resolve(null)
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function watchTask(engine: TaskEngine, id: string, args: ParsedArgs): Promise<void> {
  const timeoutSeconds = Number(args.values.get('timeout') ?? '600')
  const deadline = Date.now() + (Number.isFinite(timeoutSeconds) ? timeoutSeconds : 600) * 1000
  const stopOnWaiting = args.flags.has('stop-on-waiting')
  let last = ''
  while (Date.now() < deadline) {
    const snapshot = engine.snapshot()
    const task = snapshot.tasks.find(item => item.id === id)
    if (!task) {
      process.stderr.write('[arckeep] task not found\n')
      process.exitCode = 1
      return
    }
    const signature = [task.status, task.statusReason, task.updatedAt, task.decisionId].join('|')
    if (signature !== last) {
      last = signature
      print({
        id: task.id,
        status: task.status,
        statusReason: task.statusReason,
        decisionId: task.decisionId,
        wait: task.wait,
        result: task.result,
        rounds: task.rounds,
        costUsd: task.costUsd,
        lastError: task.lastError
      })
    }
    const finished = ['ready', 'needs_decision', 'failed', 'done', 'cancelled'].includes(task.status)
    if (finished || (stopOnWaiting && task.status === 'waiting')) return
    await sleep(1_000)
  }
  process.stderr.write('[arckeep] watch timed out\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(args.values.get('data') ?? defaultDataDir())
  mkdirSync(dataDir, { recursive: true })
  const engine = new TaskEngine({
    file: path.join(dataDir, 'tasks.json'),
    runsDir: path.join(dataDir, 'task-runs'),
    detectAgents,
    getGithubToken: githubToken,
    runAgent: runAgentProcess,
    observeGithub: observeGithubWait,
    log: message => process.stderr.write('[arckeep] ' + message + '\n'),
    notify: ({ title, body }) => process.stderr.write('[arckeep] ' + title + '：' + body + '\n'),
    onChange: payload => {
      if (args.command === 'watch') return
      if (args.flags.has('verbose')) process.stderr.write('[arckeep] change ' + JSON.stringify(payload) + '\n')
    }
  })
  await engine.start()
  await engine.refreshAgents()

  const shutdown = async () => {
    await engine.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })

  switch (args.command) {
    case 'status': {
      print(engine.snapshot())
      break
    }
    case 'detail': {
      print(engine.detail(required(args, 'id')))
      break
    }
    case 'create': {
      const task = await engine.create({
        goal: required(args, 'goal'),
        title: args.values.get('title') ?? null,
        repo: args.values.get('repo') ?? null,
        cwd: required(args, 'cwd'),
        agent: args.values.get('agent') ?? 'auto',
        autonomy: args.values.get('autonomy') ?? 'edit',
        priority: args.values.get('priority') ?? 'normal',
        source: args.values.get('source') ?? 'manual',
        start: !args.flags.has('no-start')
      })
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'start': {
      const task = engine.startTask(required(args, 'id'))
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'update': {
      const task = await engine.update({
        id: required(args, 'id'),
        ...(args.values.has('goal') ? { goal: args.values.get('goal') } : {}),
        ...(args.values.has('title') ? { title: args.values.get('title') } : {}),
        ...(args.values.has('agent') ? { agent: args.values.get('agent') } : {}),
        ...(args.values.has('autonomy') ? { autonomy: args.values.get('autonomy') } : {})
      })
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'pause': {
      print(engine.pause(required(args, 'id')))
      break
    }
    case 'resume': {
      const task = engine.resume(required(args, 'id'))
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'cancel': {
      print(engine.cancel(required(args, 'id')))
      break
    }
    case 'retry': {
      const task = engine.retry(required(args, 'id'))
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'reply': {
      const task = engine.replyDecision({
        decisionId: required(args, 'decision'),
        optionId: required(args, 'option'),
        note: args.values.get('note') ?? null
      })
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'accept': {
      print(engine.accept(required(args, 'id'), args.values.get('note') ?? null))
      break
    }
    case 'rework': {
      const task = engine.reopen(required(args, 'id'), args.values.get('feedback') ?? '')
      print(task)
      if (args.flags.has('watch')) await watchTask(engine, task.id, args)
      break
    }
    case 'tick': {
      print(await engine.refreshEvents(true))
      break
    }
    case 'watch': {
      await watchTask(engine, required(args, 'id'), args)
      break
    }
    default:
      throw new Error('未知命令：' + args.command)
  }
  if (args.command === 'watch' || args.flags.has('watch')) {
    await sleep(200)
  }
  await engine.close()
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  process.exitCode = 1
})

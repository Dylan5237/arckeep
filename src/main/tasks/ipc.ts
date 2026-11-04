import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { IpcChannel } from '../../shared/ipc.js'
import type { IpcResult } from '../../shared/types.js'
import type { Task, TaskAgentStatus, TaskDetail, TaskEngineConfig, TaskSnapshot } from '../../shared/tasks/types.js'
import type { TaskEngine } from './engine.js'

export interface TaskIpcOptions {
  engine: TaskEngine
  guard: (event: IpcMainInvokeEvent) => void
  getWindow: () => BrowserWindow | null
  launchTakeover: (task: Task) => Promise<void>
}

function failure(error: unknown, fallback: string): IpcResult<never> {
  return {
    ok: false,
    error: error instanceof Error && /[㐀-鿿]/u.test(error.message) ? error.message : fallback
  }
}

function invoke<T>(
  options: TaskIpcOptions,
  event: IpcMainInvokeEvent,
  fallback: string,
  operation: () => T | Promise<T>
): Promise<IpcResult<T>> {
  try {
    options.guard(event)
  } catch {
    return Promise.resolve({ ok: false, error: '任务请求未授权' })
  }
  return Promise.resolve()
    .then(operation)
    .then(data => ({ ok: true as const, data }))
    .catch(error => failure(error, fallback))
}

async function chooseDirectory(options: TaskIpcOptions): Promise<{ cancelled: true } | { cancelled: false, path: string }> {
  const dialogOptions = {
    title: '选择任务的本地工作目录',
    properties: ['openDirectory' as const]
  }
  const window = options.getWindow()
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || !result.filePaths[0]) return { cancelled: true }
  return { cancelled: false, path: path.resolve(result.filePaths[0]) }
}

function findArtifact(options: TaskIpcOptions, taskId: unknown, artifactId: unknown): {
  task: Task
  artifact: NonNullable<TaskDetail['task']['result']>['artifacts'][number]
} {
  if (typeof taskId !== 'string' || typeof artifactId !== 'string') throw new Error('产物参数无效')
  const detail = options.engine.detail(taskId)
  const artifact = detail.task.result?.artifacts.find(item => item.id === artifactId)
  if (!artifact) throw new Error('找不到这个产物')
  return { task: detail.task, artifact }
}

export function registerTaskIpc(options: TaskIpcOptions): void {
  ipcMain.handle(IpcChannel.getTaskSnapshot, (event) =>
    invoke(options, event, '无法读取任务列表', () => options.engine.snapshot() as TaskSnapshot))
  ipcMain.handle(IpcChannel.getTaskDetail, (event, id: unknown) =>
    invoke(options, event, '无法读取任务详情', () => {
      if (typeof id !== 'string') throw new Error('任务编号无效')
      return options.engine.detail(id)
    }))
  ipcMain.handle(IpcChannel.createTask, (event, input: unknown) =>
    invoke(options, event, '无法创建任务', () => options.engine.create(input)))
  ipcMain.handle(IpcChannel.updateTask, (event, input: unknown) =>
    invoke(options, event, '无法更新任务', () => options.engine.update(input)))
  ipcMain.handle(IpcChannel.startTask, (event, id: unknown) =>
    invoke(options, event, '无法开始任务', () => options.engine.startTask(String(id))))
  ipcMain.handle(IpcChannel.pauseTask, (event, id: unknown) =>
    invoke(options, event, '无法暂停任务', () => options.engine.pause(String(id))))
  ipcMain.handle(IpcChannel.resumeTask, (event, id: unknown) =>
    invoke(options, event, '无法恢复任务', () => options.engine.resume(String(id))))
  ipcMain.handle(IpcChannel.cancelTask, (event, id: unknown) =>
    invoke(options, event, '无法取消任务', () => options.engine.cancel(String(id))))
  ipcMain.handle(IpcChannel.retryTask, (event, id: unknown) =>
    invoke(options, event, '无法重试任务', () => options.engine.retry(String(id))))
  ipcMain.handle(IpcChannel.acceptTask, (event, id: unknown, note: unknown) =>
    invoke(options, event, '无法验收任务', () => options.engine.accept(String(id), note)))
  ipcMain.handle(IpcChannel.reopenTask, (event, id: unknown, feedback: unknown) =>
    invoke(options, event, '无法提交反馈', () => options.engine.reopen(String(id), feedback)))
  ipcMain.handle(IpcChannel.deleteTask, (event, id: unknown) =>
    invoke(options, event, '无法删除任务', () => {
      const taskId = String(id)
      options.engine.deleteTask(taskId)
      return { id: taskId }
    }))
  ipcMain.handle(IpcChannel.replyTaskDecision, (event, input: unknown) =>
    invoke(options, event, '无法提交决定', () => options.engine.replyDecision(input)))
  ipcMain.handle(IpcChannel.refreshTaskEvents, (event, force: unknown) =>
    invoke(options, event, '无法检查任务事件', () => options.engine.refreshEvents(force === true)))
  ipcMain.handle(IpcChannel.setTaskConfig, (event, input: unknown) =>
    invoke(options, event, '无法保存任务设置', () => options.engine.updateConfig(input) as Promise<TaskEngineConfig>))
  ipcMain.handle(IpcChannel.refreshTaskAgents, (event) =>
    invoke(options, event, '无法检测本机 Agent', () => options.engine.refreshAgents() as Promise<TaskAgentStatus[]>))
  ipcMain.handle(IpcChannel.pickTaskDirectory, event =>
    invoke(options, event, '无法选择工作目录', () => chooseDirectory(options)))
  ipcMain.handle(IpcChannel.openTaskArtifact, (event, taskId: unknown, artifactId: unknown) =>
    invoke(options, event, '无法打开产物', async () => {
      const { artifact } = findArtifact(options, taskId, artifactId)
      if (artifact.kind === 'text') {
        clipboard.writeText(artifact.text ?? '')
        return true as const
      }
      if (artifact.kind === 'url') {
        if (!artifact.url || !/^https?:\/\//i.test(artifact.url)) throw new Error('产物链接无效')
        await shell.openExternal(artifact.url)
        return true as const
      }
      if (!artifact.path || !existsSync(artifact.path)) throw new Error('产物文件已不存在，请查看运行日志')
      const message = await shell.openPath(artifact.path)
      if (message) throw new Error('无法打开产物：' + message)
      return true as const
    }))
  ipcMain.handle(IpcChannel.openTaskTerminal, (event, taskId: unknown) =>
    invoke(options, event, '无法打开任务终端', async () => {
      if (typeof taskId !== 'string') throw new Error('任务编号无效')
      const detail = options.engine.detail(taskId)
      if (['running', 'queued'].includes(detail.task.status)) {
        throw new Error('任务正在运行，请先暂停或等待本轮结束后接管')
      }
      // Taking over a waiting task must stop automatic event continuation while
      // the user works in the terminal.
      if (detail.task.status === 'waiting') options.engine.pause(taskId)
      await options.launchTakeover(detail.task)
      return true as const
    }))
  ipcMain.handle(IpcChannel.revealTaskRun, (event, taskId: unknown, runId: unknown) =>
    invoke(options, event, '无法定位运行日志', () => {
      if (typeof taskId !== 'string' || typeof runId !== 'string') throw new Error('运行编号无效')
      const detail = options.engine.detail(taskId)
      const run = detail.runs.find(item => item.id === runId)
      if (!run) throw new Error('找不到这次运行')
      if (!run.logFile || !existsSync(run.logFile)) throw new Error('运行日志已不存在')
      shell.showItemInFolder(run.logFile)
      return true as const
    }))
}

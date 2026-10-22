import { withDeadline } from '../shared/task-scope.js'
import { clearCaptureDraft, saveCaptureDraft } from './todos/draft.js'

export type CaptureShutdownResult = 'cleared' | 'saved' | 'preserved'

export async function flushCaptureOnShutdown(options: {
  file: string
  readDraft: () => Promise<unknown>
  isCommitted: () => boolean
  timeoutMs?: number
}): Promise<CaptureShutdownResult> {
  if (options.isCommitted()) {
    clearCaptureDraft(options.file)
    return 'cleared'
  }
  let draft: unknown
  try {
    draft = await withDeadline(
      Promise.resolve().then(options.readDraft),
      options.timeoutMs ?? 750,
      '退出前读取捕获草稿超时'
    )
  } catch {
    return 'preserved'
  }
  if (options.isCommitted()) {
    clearCaptureDraft(options.file)
    return 'cleared'
  }
  saveCaptureDraft(options.file, draft)
  return 'saved'
}

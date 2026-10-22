import type { PromptInput } from '../shared/prompts/types.js'
import type { PromptStore } from './prompts/store.js'
import type { ScreenshotScene } from './screenshot-scene.js'

/** Populates only the screenshot process's isolated userData directory. */
export function seedScreenshotPrompts(scene: ScreenshotScene, store: PromptStore): void {
  if (scene !== 'prompts' && scene !== 'prompts-narrow') return
  const fixtures: PromptInput[] = [
    {
      title: 'APO 项目初始化',
      text: '使用 https://github.com/Dylan5237/agent-project-ops 初始化当前项目。',
      tags: ['项目', '方法论'],
      pinned: true
    },
    {
      title: '交付前代码审查',
      text: '请对当前改动做严格的对抗性审查。\n\n优先检查真实缺陷、数据丢失、权限边界和异步竞态。\n每项问题请给出复现条件、影响和对应代码位置。',
      tags: ['开发', '审查'],
      pinned: true
    },
    {
      title: '把想法整理为下一步',
      text: '请基于下面的想法，整理目标、已有信息和最小可执行的下一步。\n保留尚未确认的前提；有缺口时标明需要补充的信息。',
      tags: ['产品'],
      pinned: false
    }
  ]
  for (const fixture of fixtures) store.create(fixture)
}

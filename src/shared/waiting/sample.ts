import { primaryAction } from './action.js'
import type { WaitingRow } from './types.js'

const REPOS = [
  'northwind/ledger',
  'harbor/docs',
  'kite/mobile',
  'lumen/api',
  'orchard/web',
  'atlas/billing'
]

const TITLES = [
  '验收北区截图',
  '确认支付失败重试文案',
  '补齐离线导入的空状态',
  '看一下草稿箱排序',
  '核对周报导出的列',
  '决定要不要保留旧入口',
  '回复部署窗口的选择',
  '验收设置页空态',
  '确认删除是否需要二次提示',
  '看迁移脚本的回滚步骤',
  '验收通知中心筛选',
  '确认图标在深色背景下的对比',
  '处理未命名草稿的默认标题',
  '验收搜索高亮截图',
  '确认权限不足时的下一步',
  '看本地缓存过期策略',
  '验收列表在窄窗口的折行',
  '确认批量归档的范围',
  '回复客户环境的版本差异',
  '验收打印样式',
  '确认时区显示用 UTC 还是本地',
  '看失败重试是否会重复扣次',
  '验收引导里的示例仓库',
  '确认关闭后是否留在托盘',
  '处理过期 token 的提示文案',
  '验收关注仓库留空的自动模式'
]

const REASON_SETS = [
  ['要人动手'],
  ['待你审/合'],
  ['指派'],
  ['指派', '待你审/合'],
  ['请求 review'],
  ['提及'],
  ['状态文档'],
  ['要人动手', '指派'],
  ['没推送'],
  ['提及', '要人动手'],
  ['待办']
]

/** Fifty-two synthetic rows spanning several repos, reasons, and ages. */
export function sampleWaitingRows(): WaitingRow[] {
  const days = [
    64, 58, 51, 44, 41, 36, 33, 30, 27, 24,
    22, 21, 19, 18, 16, 15, 14, 13, 12, 11,
    10, 9, 8, 7, 6, 6, 5, 5, 4, 4,
    3, 3, 2, 2, 2, 1, 1, 1, 1, 0,
    0, 0, 45, 39, 28, 17, 9, 4, 62, 3,
    8, 1
  ]
  return days.map((waitingDays, index) => {
    const repo = REPOS[index % REPOS.length] ?? 'northwind/ledger'
    const reasons = REASON_SETS[index % REASON_SETS.length] ?? ['要人动手']
    const tier = index % 9 === 0 ? 'weak' as const : 'strong' as const
    const signalText = tier === 'weak'
      ? '正文里提到了截图，没有明确请求'
      : reasons.includes('待你审/合')
        ? '最近活动 2026-09-20，已连续 3 天没有 push、评论或 review'
        : reasons.includes('请求 review')
          ? 'mina 在 2026-09-18 请求 @ada review'
          : reasons.includes('指派')
            ? 'mina 在 2026-09-12 把这件事指派给你'
            : reasons.includes('要人动手')
              ? '请确认这一版能否合入'
              : reasons.includes('提及')
                ? '@你 出现在最新评论里'
                : reasons.includes('状态文档')
                  ? 'STATUS.md 开头写着 NEEDS USER ACTION'
                  : reasons.includes('没推送')
                    ? '本地分支比 origin 超前，还没有 push'
                    : reasons.includes('待办')
                      ? '待办：核对这周要你处理的事项'
                      : reasons[0] ?? '等待'
    const type = reasons.includes('待办')
      ? 'todo' as const
      : reasons.includes('待你审/合') || reasons.includes('请求 review')
        ? 'pr' as const
        : reasons.includes('没推送')
          ? 'local-branch' as const
          : reasons.includes('状态文档') && index % 5 === 0
            ? 'status-doc' as const
            : 'issue' as const
    const number = type === 'local-branch' || type === 'todo' ? null : 120 + index
    const title = TITLES[index % TITLES.length] ?? '待处理事项'
    const slug = type === 'pr' ? 'pull' : 'issues'
    return {
      id: `sample:${repo}#${number ?? index}`,
      repo,
      number,
      type,
      title,
      url: type === 'todo'
        ? 'arckeep://todos'
        : type === 'local-branch'
          ? `https://github.com/${repo}/tree/feature-${index}`
          : `https://github.com/${repo}/${slug}/${number}`,
      reasons: [...reasons],
      action: primaryAction(type, reasons),
      parentNumber: null,
      parent: null,
      childCount: 0,
      waitingDays,
      daysEstimated: index % 7 === 0,
      signalText,
      tier,
      updatedAt: '2026-09-01T00:00:00.000Z',
      ignored: false
    }
  })
}

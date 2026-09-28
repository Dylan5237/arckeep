import { compileUserRegex } from './rules.js'
import type { StatusDocHit, StatusDocRule } from './types.js'

const ISSUE_REF = /(?:^|[^A-Za-z0-9])#(\d+)\b|issues\/(\d+)\b/

export function issueNumberInText(text: string): number | null {
  const match = ISSUE_REF.exec(text)
  if (!match) return null
  const raw = match[1] ?? match[2]
  if (!raw) return null
  const number = Number(raw)
  return Number.isInteger(number) && number > 0 ? number : null
}

export function matchStatusDocText(text: string, rule: StatusDocRule, eventAt: string | null): StatusDocHit[] {
  const pattern = compileUserRegex(rule.pattern, '状态文档正则')
  const lines = text.split(/\r?\n/)
  const hits: StatusDocHit[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.trim()) continue
    if (!pattern.test(line)) continue
    const issueNumber = issueNumberInText(line)
    const fileTarget = !/^#?\d+$/.test(rule.target)
    const url = issueNumber
      ? `https://github.com/${rule.repo}/issues/${issueNumber}`
      : fileTarget
        ? `https://github.com/${rule.repo}/blob/HEAD/${rule.target}#L${index + 1}`
        : `https://github.com/${rule.repo}/issues/${rule.target.replace(/^#/, '')}`
    hits.push({
      repo: rule.repo,
      target: rule.target,
      line: index + 1,
      text: line.trim().slice(0, 180),
      url,
      issueNumber,
      eventAt
    })
    if (hits.length >= 50) break
  }
  return hits
}

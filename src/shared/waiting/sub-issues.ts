export function parentRef(repo: string, parentNumber: number | null): string | number | null {
  if (parentNumber == null) return null
  if (repo.includes('/')) return `https://github.com/${repo}/issues/${parentNumber}`
  return parentNumber
}

/** Count qualifying children that are in this same list. */
export function annotateIssueFamily<T extends { repo: string, number: number | null, parentNumber: number | null }>(
  rows: readonly T[]
): Array<T & { parent: string | number | null, childCount: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.parentNumber == null || !row.repo) continue
    const key = `${row.repo.toLowerCase()}#${row.parentNumber}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return rows.map(row => ({
    ...row,
    parent: parentRef(row.repo, row.parentNumber),
    childCount: row.number == null ? 0 : (counts.get(`${row.repo.toLowerCase()}#${row.number}`) ?? 0)
  }))
}

/** Issue references on a GitHub tasklist line. Prose that merely contains #12 is not a link. */
export function tasklistIssueRefs(body: string, repo: string): { repo: string, number: number }[] {
  const found: { repo: string, number: number }[] = []
  const seen = new Set<string>()
  const push = (name: string, number: number) => {
    if (!Number.isInteger(number) || number < 1) return
    const key = `${name.toLowerCase()}#${number}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ repo: name, number })
  }
  for (const line of body.split(/\r?\n/)) {
    const item = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/.exec(line)
    if (!item) continue
    const text = item[1] ?? ''
    const url = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/i.exec(text)
    if (url?.[1] && url[2] && url[3]) {
      push(`${url[1]}/${url[2]}`, Number(url[3]))
      continue
    }
    const cross = /(?:^|\s)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/.exec(text)
    if (cross?.[1] && cross[2] && cross[3]) {
      push(`${cross[1]}/${cross[2]}`, Number(cross[3]))
      continue
    }
    const local = /(?:^|\s)#(\d+)\b/.exec(text)
    if (local?.[1]) push(repo, Number(local[1]))
  }
  return found
}

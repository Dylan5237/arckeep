export interface JsonLocation {
  line: number
  column: number
}

export function indexToLocation(text: string, index: number): JsonLocation {
  let line = 1
  let column = 1
  const end = Math.max(0, Math.min(index, text.length))
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}

export function syntaxErrorLocation(text: string, error: Error): JsonLocation {
  const match = /position (\d+)/.exec(error.message)
  if (!match) return { line: 1, column: 1 }
  return indexToLocation(text, Number(match[1]))
}

function skipWs(text: string, pos: { i: number }): void {
  while (pos.i < text.length && /\s/.test(text[pos.i])) pos.i += 1
}

function parseString(text: string, pos: { i: number }): string {
  if (text[pos.i] !== '"') throw new Error('expected string')
  pos.i += 1
  let out = ''
  while (pos.i < text.length) {
    const ch = text[pos.i]
    if (ch === '"') {
      pos.i += 1
      return out
    }
    if (ch === '\\') {
      const esc = text[pos.i + 1]
      pos.i += 2
      if (esc === 'u') {
        const hex = text.slice(pos.i, pos.i + 4)
        pos.i += 4
        out += String.fromCharCode(Number.parseInt(hex, 16))
      } else if (esc === 'n') out += '\n'
      else if (esc === 'r') out += '\r'
      else if (esc === 't') out += '\t'
      else out += esc ?? ''
      continue
    }
    out += ch
    pos.i += 1
  }
  throw new Error('unterminated string')
}

function skipValue(text: string, pos: { i: number }): void {
  skipWs(text, pos)
  const ch = text[pos.i]
  if (ch === '"') {
    parseString(text, pos)
    return
  }
  if (ch === '{') {
    pos.i += 1
    skipWs(text, pos)
    if (text[pos.i] === '}') {
      pos.i += 1
      return
    }
    while (pos.i < text.length) {
      skipWs(text, pos)
      parseString(text, pos)
      skipWs(text, pos)
      pos.i += 1
      skipValue(text, pos)
      skipWs(text, pos)
      if (text[pos.i] === ',') {
        pos.i += 1
        continue
      }
      if (text[pos.i] === '}') {
        pos.i += 1
        return
      }
      throw new Error('expected comma or }')
    }
  }
  if (ch === '[') {
    pos.i += 1
    skipWs(text, pos)
    if (text[pos.i] === ']') {
      pos.i += 1
      return
    }
    while (pos.i < text.length) {
      skipValue(text, pos)
      skipWs(text, pos)
      if (text[pos.i] === ',') {
        pos.i += 1
        continue
      }
      if (text[pos.i] === ']') {
        pos.i += 1
        return
      }
      throw new Error('expected comma or ]')
    }
  }
  while (pos.i < text.length && !',}]'.includes(text[pos.i]) && !/\s/.test(text[pos.i])) pos.i += 1
}

function walk(text: string, pos: { i: number }, parts: string[]): number | null {
  skipWs(text, pos)
  if (parts.length === 0) return pos.i
  if (text[pos.i] === '{') return walkObject(text, pos, parts)
  if (text[pos.i] === '[') return walkArray(text, pos, parts)
  return null
}

function walkObject(text: string, pos: { i: number }, parts: string[]): number | null {
  pos.i += 1
  skipWs(text, pos)
  if (text[pos.i] === '}') return null
  while (pos.i < text.length) {
    skipWs(text, pos)
    const key = parseString(text, pos)
    skipWs(text, pos)
    pos.i += 1
    if (key === parts[0]) {
      skipWs(text, pos)
      if (parts.length === 1) return pos.i
      return walk(text, pos, parts.slice(1))
    }
    skipValue(text, pos)
    skipWs(text, pos)
    if (text[pos.i] === ',') {
      pos.i += 1
      continue
    }
    return null
  }
  return null
}

function walkArray(text: string, pos: { i: number }, parts: string[]): number | null {
  const index = Number(parts[0])
  pos.i += 1
  if (!Number.isInteger(index) || index < 0) return null
  skipWs(text, pos)
  if (text[pos.i] === ']') return null
  let cursor = 0
  while (pos.i < text.length) {
    if (cursor === index) {
      skipWs(text, pos)
      if (parts.length === 1) return pos.i
      return walk(text, pos, parts.slice(1))
    }
    skipValue(text, pos)
    cursor += 1
    skipWs(text, pos)
    if (text[pos.i] === ',') {
      pos.i += 1
      continue
    }
    return null
  }
  return null
}

export function locateJsonPointer(text: string, pointer: string): JsonLocation {
  if (!pointer) return { line: 1, column: 1 }
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  try {
    const found = walk(text, { i: 0 }, parts)
    return indexToLocation(text, found ?? 0)
  } catch {
    return { line: 1, column: 1 }
  }
}

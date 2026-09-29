import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function assetPath(name: string): string {
  return path.join(here, '../../schema', name)
}

let exampleCache: string | null = null
let schemaCache: unknown = null

export function toolShelfExampleText(): string {
  if (exampleCache === null) {
    exampleCache = readFileSync(assetPath('tool-shelf.example.json'), 'utf8')
  }
  return exampleCache
}

export function toolShelfSchemaDocument(): unknown {
  if (schemaCache === null) {
    schemaCache = JSON.parse(readFileSync(assetPath('tool-shelf.schema.json'), 'utf8')) as unknown
  }
  return schemaCache
}

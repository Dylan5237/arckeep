import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsService } from '../src/main/settings-service.js'
import { settingsFilePath } from '../src/main/paths.js'
import { createSafeStorageBox, type SafeStorageLike, type SecretBox } from '../src/main/token-store.js'
import type { HotkeyRegistrar } from '../src/main/hotkey.js'

const TOKEN = 'ghp_plainTextToken123456'

function xorBox(): SecretBox {
  return {
    encrypt(plain: string) {
      const xored = Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('base64')
    },
    decrypt(payload: string) {
      const xored = Uint8Array.from(Buffer.from(payload, 'base64'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('utf8')
    }
  }
}

function memoryStorage(available: boolean): SafeStorageLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString(plain: string) {
      calls.push('encrypt')
      const xored = Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0xa5)
      return Buffer.from(xored)
    },
    decryptString(encrypted: Buffer) {
      calls.push('decrypt')
      const plain = Uint8Array.from(encrypted, byte => byte ^ 0xa5)
      return Buffer.from(plain).toString('utf8')
    }
  }
}

function registrar(): HotkeyRegistrar {
  const registered = new Set<string>()
  return {
    register(accelerator: string) {
      registered.add(accelerator)
      return true
    },
    isRegistered(accelerator: string) {
      return registered.has(accelerator)
    },
    unregister(accelerator: string) {
      registered.delete(accelerator)
    }
  }
}

function readTree(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return readTree(full)
    return readFileSync(full)
  }).join('\n')
}

describe('safeStorage token box', () => {
  it('round-trips through a mocked safeStorage and refuses plaintext encryption', () => {
    const storage = memoryStorage(true)
    const box = createSafeStorageBox(storage)
    const ciphertext = box.encrypt(TOKEN)
    expect(ciphertext.includes(TOKEN.slice(0, 8))).toBe(false)
    expect(box.decrypt(ciphertext)).toBe(TOKEN)
    expect(storage.calls).toEqual(['encrypt', 'decrypt'])
  })

  it('does not write a token when safeStorage is unavailable', () => {
    const storage = memoryStorage(false)
    const box = createSafeStorageBox(storage)
    expect(() => box.encrypt(TOKEN)).toThrow(/拒绝明文保存/)
    expect(storage.calls).toEqual([])

    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-token-'))
    const file = settingsFilePath(dir)
    const service = new SettingsService({
      file,
      secretBox: box,
      registrar: registrar(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    const result = service.setPat(TOKEN)
    expect(result.ok).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('stores ciphertext only and keeps the token prefix off disk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-token-'))
    const file = settingsFilePath(dir)
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: registrar(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    expect(service.setPat(TOKEN).ok).toBe(true)
    const disk = readTree(dir)
    expect(disk.includes(TOKEN.slice(0, 8))).toBe(false)
    expect(disk.includes(TOKEN)).toBe(false)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { patCiphertext: string }
    expect(saved.patCiphertext).toBeTruthy()
    expect(xorBox().decrypt(saved.patCiphertext)).toBe(TOKEN)
  })
})

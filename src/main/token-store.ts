export interface SecretBox {
  encrypt(plain: string): string
  decrypt(payload: string): string
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function createSafeStorageBox(storage: SafeStorageLike): SecretBox {
  return {
    encrypt(plain: string): string {
      if (!storage.isEncryptionAvailable()) {
        throw new Error('当前系统无法加密 token（safeStorage 不可用），已拒绝明文保存')
      }
      const ciphertext = storage.encryptString(plain).toString('base64')
      if (plain.length >= 8 && ciphertext.includes(plain)) {
        throw new Error('加密结果仍包含明文 token，已拒绝保存')
      }
      return ciphertext
    },
    decrypt(payload: string): string {
      if (!storage.isEncryptionAvailable()) {
        throw new Error('当前系统无法解密 token（safeStorage 不可用）')
      }
      return storage.decryptString(Buffer.from(payload, 'base64'))
    }
  }
}

export function assertSerializedWithoutSecret(serialized: string, secret: string): void {
  if (secret.length >= 8 && serialized.includes(secret.slice(0, 8))) {
    throw new Error('设置文件将包含明文 token，已拒绝写入')
  }
}

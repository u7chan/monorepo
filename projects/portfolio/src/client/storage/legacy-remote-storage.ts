import crypto from 'crypto-js'

const LEGACY_CRYPTO_JS_PREFIX = 'U2FsdGVkX1'
const LEGACY_SETTINGS_AES_KEY = '3f1a9c7e5d4b8f012367a9c4e2d5b7f0'

export function decryptLegacyApiKey(value: string): string | null {
  if (!value) {
    return ''
  }

  if (!value.startsWith(LEGACY_CRYPTO_JS_PREFIX)) {
    return value
  }

  try {
    const decrypted = crypto.AES.decrypt(value, LEGACY_SETTINGS_AES_KEY).toString(crypto.enc.Utf8)
    return decrypted || null
  } catch {
    return null
  }
}

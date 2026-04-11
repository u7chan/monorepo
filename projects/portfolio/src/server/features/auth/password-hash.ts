import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PASSWORD_HASH_ALGORITHM = 'scrypt'
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
} as const

interface ParsedPasswordHash {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_OPTIONS.keyLength, {
    N: SCRYPT_OPTIONS.N,
    r: SCRYPT_OPTIONS.r,
    p: SCRYPT_OPTIONS.p,
  })

  return [
    PASSWORD_HASH_ALGORITHM,
    `N=${SCRYPT_OPTIONS.N},r=${SCRYPT_OPTIONS.r},p=${SCRYPT_OPTIONS.p}`,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$')
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  try {
    const parsed = parsePasswordHash(encodedHash)
    const derivedHash = scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    })

    return timingSafeEqual(derivedHash, parsed.hash)
  } catch {
    return false
  }
}

function parsePasswordHash(encodedHash: string): ParsedPasswordHash {
  const [algorithm, params, saltBase64, hashBase64] = encodedHash.split('$')

  if (algorithm !== PASSWORD_HASH_ALGORITHM || !params || !saltBase64 || !hashBase64) {
    throw new Error('Unsupported password hash format')
  }

  const parsedParams = Object.fromEntries(
    params.split(',').map((entry) => {
      const [key, value] = entry.split('=')
      return [key, Number(value)]
    })
  )

  const salt = Buffer.from(saltBase64, 'base64')
  const hash = Buffer.from(hashBase64, 'base64')

  if (
    !salt.length ||
    !hash.length ||
    !Number.isFinite(parsedParams.N) ||
    !Number.isFinite(parsedParams.r) ||
    !Number.isFinite(parsedParams.p)
  ) {
    throw new Error('Invalid password hash payload')
  }

  return {
    N: parsedParams.N,
    r: parsedParams.r,
    p: parsedParams.p,
    salt,
    hash,
  }
}

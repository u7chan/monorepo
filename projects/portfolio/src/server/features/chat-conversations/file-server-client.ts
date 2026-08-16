import { logger } from '#/server/lib/logger'

export interface FileServerCredentials {
  username: string
  password: string
}

export interface FileServerConfig {
  baseUrl: string
  publicBaseUrl: string
  credentials: FileServerCredentials
}

export interface FileServerEnv {
  FILE_SERVER_URL?: string
  FILE_SERVER_PUBLIC_URL?: string
  FILE_SERVER_ADMIN_USERNAME?: string
  FILE_SERVER_ADMIN_PASSWORD?: string
}

export interface FileServerRequestOptions {
  signal?: AbortSignal
}

export function resolveFileServerBaseUrl(env: Pick<FileServerEnv, 'FILE_SERVER_URL'>): string | null {
  const baseUrl = (env.FILE_SERVER_URL ?? '').trim()

  if (!baseUrl) {
    return null
  }

  return baseUrl.replace(/\/$/, '')
}

export function resolveFileServerPublicBaseUrl(env: Pick<FileServerEnv, 'FILE_SERVER_PUBLIC_URL'>): string | null {
  const baseUrl = (env.FILE_SERVER_PUBLIC_URL ?? '').trim()

  if (!baseUrl) {
    return null
  }

  return baseUrl.replace(/\/$/, '')
}

export function resolveFileServerPublicOrigin(env: Pick<FileServerEnv, 'FILE_SERVER_PUBLIC_URL'>): string | null {
  const baseUrl = resolveFileServerPublicBaseUrl(env)

  if (!baseUrl) {
    return null
  }

  try {
    const url = new URL(baseUrl)

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null
    }

    const origin = url.origin
    if (!/^https?:\/\/(?:[a-z\d.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i.test(origin)) {
      return null
    }

    return origin
  } catch {
    return null
  }
}

export function buildFileServerPreviewUrl(publicBaseUrl: string, publicPath: string): string {
  return `${publicBaseUrl}${publicPath}`
}

export async function checkFileExists(
  publicBaseUrl: string,
  publicPath: string,
  options: FileServerRequestOptions = {}
): Promise<boolean> {
  const request: RequestInit = { method: 'HEAD' }
  if (options.signal) {
    request.signal = options.signal
  }

  const res = await fetch(buildFileServerPreviewUrl(publicBaseUrl, publicPath), request)
  return res.ok
}

/**
 * file-server の設定を env から解決する。
 * 現時点では固定 admin credentials を使うが、将来 portfolio user と
 * file-server user の対応付けに差し替えられるよう helper で閉じ込める。
 */
export function resolveFileServerConfig(env: FileServerEnv): FileServerConfig | null {
  const baseUrl = resolveFileServerBaseUrl(env)
  const publicBaseUrl = resolveFileServerPublicBaseUrl(env)
  const username = (env.FILE_SERVER_ADMIN_USERNAME ?? '').trim()
  const password = env.FILE_SERVER_ADMIN_PASSWORD ?? ''

  if (!baseUrl || !publicBaseUrl || !username || !password) {
    return null
  }

  return {
    baseUrl,
    publicBaseUrl,
    credentials: { username, password },
  }
}

const SESSION_COOKIE_NAME = 'session'

function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) {
    return null
  }
  const cookies = setCookieHeader.split(/,(?=\s*[^;]+=)/)
  for (const raw of cookies) {
    const [pair] = raw.split(';')
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE_NAME) {
      return rest.join('=')
    }
  }
  return null
}

/**
 * file-server に POST /login して session cookie の値を取得する。
 */
export async function loginToFileServer(
  config: FileServerConfig,
  options: FileServerRequestOptions = {}
): Promise<string> {
  const form = new URLSearchParams()
  form.set('username', config.credentials.username)
  form.set('password', config.credentials.password)
  form.set('returnTo', '/')

  const request: RequestInit = {
    method: 'POST',
    body: form,
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
  if (options.signal) {
    request.signal = options.signal
  }

  const res = await fetch(`${config.baseUrl}/login`, request)

  if (res.status !== 302 && res.status !== 303 && !res.ok) {
    const text = await res.text().catch(() => '')
    logger.warn({ status: res.status, body: text.slice(0, 200) }, 'file-server login failed')
    throw new Error(`file-server login failed: ${res.status}`)
  }

  const session = extractSessionCookie(res.headers.get('set-cookie'))
  if (!session) {
    throw new Error('file-server login did not return session cookie')
  }
  return session
}

/**
 * file-server の読み取りAPIに GET して、JSON のファイル一覧を確認する。
 */
export async function readFileServerApi(
  config: FileServerConfig,
  session: string,
  options: FileServerRequestOptions = {}
): Promise<void> {
  const request: RequestInit = {
    method: 'GET',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
      accept: 'application/json',
    },
  }
  if (options.signal) {
    request.signal = options.signal
  }

  const res = await fetch(`${config.baseUrl}/api/`, request)
  if (!res.ok) {
    throw new Error(`file-server read failed: ${res.status}`)
  }

  const payload = (await res.json().catch(() => null)) as { files?: unknown } | null
  if (!payload || !Array.isArray(payload.files)) {
    throw new Error('file-server read returned an invalid response')
  }
}

/**
 * file-server に POST /api/upload する。
 * path は virtual path で、ディレクトリまたは保存先ファイルパスを指定する。
 */
export async function uploadFileToFileServer(
  config: FileServerConfig,
  session: string,
  params: {
    fileName: string
    content: string | ArrayBuffer
    contentType: string
    path: string
  }
): Promise<void> {
  const form = new FormData()
  const blob = new Blob([params.content], { type: params.contentType })
  form.set('files', blob, params.fileName)
  form.set('path', params.path)

  const res = await fetch(`${config.baseUrl}/api/upload`, {
    method: 'POST',
    body: form,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logger.warn({ status: res.status, body: text.slice(0, 200) }, 'file-server upload failed')
    throw new Error(`file-server upload failed: ${res.status}`)
  }

  const payload = (await res.json().catch(() => null)) as {
    success?: boolean
    uploaded?: string[]
    failed?: Array<{ name: string; reason: string }>
  } | null
  if (payload && payload.success === false) {
    const reason = payload.failed?.[0]?.reason ?? 'unknown'
    throw new Error(`file-server upload rejected: ${reason}`)
  }
}

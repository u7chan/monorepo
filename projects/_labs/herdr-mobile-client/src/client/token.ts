const STORAGE_KEY = "herdr-mobile-client.token"

export function loadToken(): string | null {
  return sessionStorage.getItem(STORAGE_KEY)
}

export function saveToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token)
}

export function clearToken(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}

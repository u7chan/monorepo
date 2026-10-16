import { hc } from "hono/client"
import type { ApiType, PublicApiType } from "../server/app"

// 同じオリジン（dev では Vite の /api proxy、本番では Hono）へ相対パスで呼ぶ。
export const api = hc<ApiType>("/")

// 認証不要の公開 API。認証ミドルウェアより前に登録したルートだけを型として渡す。
export const publicApi = hc<PublicApiType>("/")

export function authorizationHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

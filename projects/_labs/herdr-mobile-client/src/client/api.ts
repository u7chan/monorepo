import { hc } from "hono/client"
import type { ApiType } from "../server/app"

// 同じオリジン（dev では Vite の /api proxy、本番では Hono）へ相対パスで呼ぶ。
export const api = hc<ApiType>("/")

export function authorizationHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

import { redirect } from '@tanstack/react-router'
import { isSignedIn } from '#/client/shared/lib/meta-props'

/**
 * ログイン必須ページの入口ガード。
 * 未ログインでも画面自体は描画できてしまい、送信時に 401 になるだけなので、Home へ戻す。
 */
export function requireSignedIn(): void {
  if (isSignedIn()) return

  throw redirect({ to: '/' })
}

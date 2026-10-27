import { z } from 'zod'

/**
 * 上流 LLM の base-url 検証。
 *
 * LAN のローカル LLM (`http://192.0.2.10:11434`) は正規の用途なので scheme は http/https に留める。
 * 末尾スラッシュを残すと SDK が `/chat/completions` を連結したときに `//chat/completions` になり、
 * リダイレクトを追わない設定と組み合わせると 301 で失敗するため、ここで正規化する。
 */
export const UpstreamBaseUrlSchema = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''))

export type UpstreamBaseUrl = z.infer<typeof UpstreamBaseUrlSchema>

import { z } from 'zod'
import { createEnv } from '@t3-oss/env-nextjs'

export const env = createEnv({
  /*
   * サーバーサイドでのみ使用する環境変数です。
   * クライアントサイドからアクセスしようとすると、実行時にエラーが発生します。
   */
  server: {
    LITELLM_API_BASE_URL: z.url(),
    LITELLM_API_KEY: z.string().min(1),
  },

  /*
   * クライアントサイド（およびサーバーサイド）から利用できる環境変数です。
   *
   * 💡 これらの変数は必ず `NEXT_PUBLIC_` で始めてください。
   *    そうでない場合、型エラーになります。
   */
  client: {
    NEXT_PUBLIC_DEBUG: z.string().optional(),
  },

  /*
   * Next.js の仕様上、Edge ランタイムやクライアントバンドルで
   * 環境変数が正しく参照されるよう、ここで明示的に指定する必要があります。
   *
   * 💡 `server` と `client` に定義したすべての環境変数を
   *    `runtimeEnv` に含めないと、型エラーが発生します。
   */
  runtimeEnv: {
    LITELLM_API_BASE_URL: process.env.LITELLM_API_BASE_URL,
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    NEXT_PUBLIC_DEBUG: process.env.NEXT_PUBLIC_DEBUG,
  },
  skipValidation: process.env.SKIP_ENV_VALIDATIONS === 'true',
})

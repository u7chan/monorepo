export function handleAgentStreamError(error: any): string {
  if (typeof error === 'string') {
    console.warn('[WARN] Agent stream chunk error (string)', error)
    return error
  }
  console.error('[ERROR] Agent stream chunk error (object)', error)

  // 安全にerrorMessage抽出（パターン対応）
  let errorMessage = 'Unknown error'

  if (error) {
    // パターン1: { error: { message: string } }
    if (typeof error === 'object' && error !== null && 'error' in error) {
      errorMessage = (error as any).error?.message ?? errorMessage
    }

    // パターン2: ErrorインスタンスのresponseBodyから抽出
    if ('responseBody' in (error as any) && typeof (error as any).responseBody === 'string') {
      try {
        const body = JSON.parse((error as any).responseBody)
        errorMessage = body.error?.message ?? errorMessage
      } catch {
        // parse失敗時はresponseBodyそのまま
        errorMessage = (error as any).responseBody
      }
    }
  }

  return errorMessage
}

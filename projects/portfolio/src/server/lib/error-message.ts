export const isProduction = () => process.env.NODE_ENV === 'production'

export const getErrorMessage = (err: unknown, fallback: string) => {
  if (isProduction()) return fallback

  return err instanceof Error ? err.message : fallback
}

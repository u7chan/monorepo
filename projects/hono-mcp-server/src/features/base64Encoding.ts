export function base64Encoding(content: string): string {
  return Buffer.from(content).toString('base64')
}

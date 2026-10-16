import qrcode from "qrcode-generator"

export const QR_QUIET_ZONE_MODULES = 4

// 誤り訂正は試作に合わせて M にする。qrcode-generator はセグメント最適化をしないため、
// LAN IP とポートを含む URL では version 3（29×29）ではなく 1 段大きい QR になるが、
// 端末の幅（41 列）には収まる。
const QR_ERROR_CORRECTION = "M"

const BLACK_ON_WHITE = "\x1b[47m\x1b[30m"
const ANSI_RESET = "\x1b[0m"

export type PairPayload = {
  url: string
  expiresAt: string
}

export function parsePairPayload(value: unknown): PairPayload | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const { url, expiresAt } = value as { url?: unknown; expiresAt?: unknown }

  if (typeof url !== "string" || url === "" || typeof expiresAt !== "string" || expiresAt === "") {
    return null
  }

  return { url, expiresAt }
}

export function pairQrModules(url: string): boolean[][] {
  const qr = qrcode(0, QR_ERROR_CORRECTION)

  qr.addData(url)
  qr.make()

  const count = qr.getModuleCount()

  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => qr.isDark(row, column)),
  )
}

export function renderQr(modules: readonly (readonly boolean[])[]): string {
  const size = modules.length + QR_QUIET_ZONE_MODULES * 2
  const lines: string[] = []

  for (let line = 0; line < Math.ceil(size / 2); line++) {
    let text = BLACK_ON_WHITE

    for (let column = 0; column < size; column++) {
      const top = isDark(modules, column, line * 2)
      const bottom = isDark(modules, column, line * 2 + 1)

      text += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }

    lines.push(text)
  }

  return `${lines.join("\n")}${ANSI_RESET}\n`
}

export function remainingSeconds(expiresAt: string, now: number): number | null {
  const expires = Date.parse(expiresAt)

  if (Number.isNaN(expires)) {
    return null
  }

  return Math.max(0, Math.ceil((expires - now) / 1000))
}

function isDark(modules: readonly (readonly boolean[])[], x: number, y: number): boolean {
  const row = y - QR_QUIET_ZONE_MODULES
  const column = x - QR_QUIET_ZONE_MODULES

  if (row < 0 || column < 0 || row >= modules.length || column >= modules.length) {
    return false
  }

  return modules[row]?.[column] === true
}

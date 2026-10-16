const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

export function normalizeRemoteAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string") {
    return null
  }

  const value = address.trim()

  if (value === "") {
    return null
  }

  // IPv4 で待ち受けた接続は ::ffff:127.0.0.1 として見える。表記の差で発行可否が変わらないように揃える。
  const mapped = IPV4_MAPPED_PATTERN.exec(value)

  return mapped === null ? value : mapped[1]!
}

// 127.0.0.0/8 をまとめて loopback とは見なさない。発行を許すのは Issue の指定どおり 127.0.0.1 と ::1 だけにする。
export function isLoopbackAddress(address: string | null | undefined): boolean {
  const normalized = normalizeRemoteAddress(address)

  return normalized === "127.0.0.1" || normalized === "::1"
}

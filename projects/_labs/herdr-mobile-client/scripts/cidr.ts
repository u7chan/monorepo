export type NormalizedCidr = string

// Windows は規則の RemoteAddress を、設定した CIDR と同じ表記では返さない（192.0.2.0/24 を入れると
// 192.0.2.0/255.255.255.0 で返る）。表記に依存せず比較するため、ネットワークアドレスとプレフィックス長へ揃える。
export function normalizedCidr(value: string): NormalizedCidr | null {
  const [address, mask, ...rest] = value.trim().split("/")

  if (address === undefined || mask === undefined || rest.length > 0) {
    return null
  }

  const addressValue = parseIpv4(address)
  const prefixLength = mask.includes(".") ? prefixLengthFromMask(parseIpv4(mask)) : parsePrefixLength(mask)

  if (addressValue === null || prefixLength === null) {
    return null
  }

  return `${formatIpv4(maskAddress(addressValue, prefixLength))}/${prefixLength}`
}

export function cidrMatchesAny(expected: string, candidates: readonly string[]): boolean {
  const normalizedExpected = normalizedCidr(expected)

  if (normalizedExpected === null) {
    return false
  }

  return candidates.some((candidate) => normalizedCidr(candidate) === normalizedExpected)
}

function parseIpv4(value: string): number | null {
  const octets = value.trim().split(".")

  if (octets.length !== 4) {
    return null
  }

  let parsed = 0

  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/.test(octet)) {
      return null
    }

    const number = Number(octet)

    if (number > 255) {
      return null
    }

    parsed = ((parsed << 8) | number) >>> 0
  }

  return parsed
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".")
}

function parsePrefixLength(value: string): number | null {
  if (!/^[0-9]{1,2}$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return parsed <= 32 ? parsed : null
}

// マスクの 1 がビット列として連続していない値（255.0.255.0 など）は、どのネットワークも指さないため受け付けない。
function prefixLengthFromMask(mask: number | null): number | null {
  if (mask === null) {
    return null
  }

  let prefixLength = 0
  let sawZero = false

  for (let bit = 31; bit >= 0; bit--) {
    if (((mask >>> bit) & 1) === 1) {
      if (sawZero) {
        return null
      }

      prefixLength++
    } else {
      sawZero = true
    }
  }

  return prefixLength
}

function maskAddress(address: number, prefixLength: number): number {
  return (address & prefixToMask(prefixLength)) >>> 0
}

function prefixToMask(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
}

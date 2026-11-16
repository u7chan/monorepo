const UNIT_SUFFIX: Record<string, string> = {
  image: "/枚",
  megapixel: "/MP",
  token: "/1M tok",
  request: "/回",
};

/** token 建ては 1 枚の実額ではないため、1M token あたりに揃えて桁を読めるようにする */
const TOKEN_SCALE = 1_000_000;

/**
 * `$` を付けた単価。未知の `unit` は整形しない（サーバーが落としている前提の防御）。
 * 6 桁で切るのは、上流の最小単価（$0.000006）でも 0 に潰れないため。
 */
export function formatCost(costUsd: number, unit: string): string {
  const suffix = UNIT_SUFFIX[unit];

  if (suffix === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return "--";
  }

  const value = unit === "token" ? costUsd * TOKEN_SCALE : costUsd;

  return `$${trimFraction(value)}${suffix}`;
}

function trimFraction(value: number): string {
  const fixed = value.toFixed(6);

  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** epoch ms を JST の分まで。マスタの鮮度は分単位で足りる */
export function formatFetchedAt(fetchedAt: number): string {
  const date = new Date(fetchedAt);

  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";

  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

const UNIT_FORMAT: Record<string, { suffix: string; scale: number }> = {
  image: { suffix: "/枚", scale: 1 },
  megapixel: { suffix: "/MP", scale: 1 },
  token: { suffix: "/1M tok", scale: 1_000_000 },
  character: { suffix: "/1M 文字", scale: 1_000_000 },
  byte: { suffix: "/1M bytes", scale: 1_000_000 },
  minute: { suffix: "/分", scale: 1 },
  request: { suffix: "/回", scale: 1 },
};

/**
 * `$` を付けた単価。未知の `unit` は整形しない（サーバーが落としている前提の防御）。
 * 6 桁で切るのは、上流の最小単価（$0.000006）でも 0 に潰れないため。
 */
export function formatCost(costUsd: number, unit: string): string {
  const format = UNIT_FORMAT[unit];

  if (format === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return "--";
  }

  return `$${trimFraction(costUsd * format.scale)}${format.suffix}`;
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

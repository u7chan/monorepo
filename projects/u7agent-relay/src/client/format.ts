const formatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

export function formatDateTime(value: number | null): string {
  return value === null ? "—" : formatter.format(new Date(value));
}

export function formatRelative(value: number | null, now = Date.now()): string {
  if (value === null) {
    return "—";
  }

  const seconds = Math.max(0, Math.round((now - value) / 1000));

  if (seconds < 60) {
    return `${seconds} 秒前`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分前`;
  }

  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} 時間前`;
  }

  return `${Math.floor(seconds / 86_400)} 日前`;
}

/** 実行 ID は 16 hex。一覧では先頭だけ見せるが、コピーできるよう全体は title に入れる。 */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

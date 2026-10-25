export const SERVICE_NAME = "usage-portal";

export type DatabaseStatus = "ok" | "error";
export type AuthStatus = "ok" | "setup_required" | "misconfigured";

export type HealthReport = {
  ok: boolean;
  service: typeof SERVICE_NAME;
  db: DatabaseStatus;
  auth: AuthStatus;
};

export function buildHealthReport(db: DatabaseStatus, auth: AuthStatus): HealthReport {
  // PIN 未設定は初回セットアップ待ちであり、故障ではない。healthcheck で unhealthy にしない。
  const ok = db === "ok" && auth !== "misconfigured";

  return { ok, service: SERVICE_NAME, db, auth };
}

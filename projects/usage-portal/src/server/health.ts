export const SERVICE_NAME = "usage-portal";

export type DatabaseStatus = "ok" | "error";
export type AuthStatus = "ok" | "misconfigured";

export type HealthReport = {
  ok: boolean;
  service: typeof SERVICE_NAME;
  db: DatabaseStatus;
  auth: AuthStatus;
};

export function buildHealthReport(db: DatabaseStatus, auth: AuthStatus): HealthReport {
  return { ok: db === "ok" && auth === "ok", service: SERVICE_NAME, db, auth };
}

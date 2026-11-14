import { describe, expect, test } from "bun:test";
import { formatTagDateTime } from "./tagDateTime";

describe("formatTagDateTime", () => {
  test("UTC の日時を JST の YYYY-MM-DD HH:mm:ss で返す", () => {
    expect(formatTagDateTime("2026-11-13T13:06:22Z")).toBe("2026-11-13 22:06:22");
    expect(formatTagDateTime("2026-11-13T13:06:22.987Z")).toBe("2026-11-13 22:06:22");
  });

  test("UTC で日付をまたぐ時刻は JST の翌日になる", () => {
    expect(formatTagDateTime("2026-11-13T23:30:00Z")).toBe("2026-11-14 08:30:00");
    expect(formatTagDateTime("2026-11-13T15:00:00Z")).toBe("2026-11-14 00:00:00");
    expect(formatTagDateTime("2026-11-13T14:59:59Z")).toBe("2026-11-13 23:59:59");
  });

  test("日時が無い、または解析できない場合は undefined を返す", () => {
    expect(formatTagDateTime(undefined)).toBeUndefined();
    expect(formatTagDateTime("")).toBeUndefined();
    expect(formatTagDateTime("not-a-date")).toBeUndefined();
  });
});

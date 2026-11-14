import { describe, expect, test } from "bun:test";
import { formatTagDate } from "./tagDate";

describe("formatTagDate", () => {
  test("UTC の日時を JST の YYYY-MM-DD で返す", () => {
    expect(formatTagDate("2026-11-13T13:06:22Z")).toBe("2026-11-13");
  });

  test("UTC で日付をまたぐ時刻は JST の翌日になる", () => {
    expect(formatTagDate("2026-11-13T23:30:00Z")).toBe("2026-11-14");
    expect(formatTagDate("2026-11-13T15:00:00Z")).toBe("2026-11-14");
    expect(formatTagDate("2026-11-13T14:59:59Z")).toBe("2026-11-13");
  });

  test("日時が無い、または解析できない場合は undefined を返す", () => {
    expect(formatTagDate(undefined)).toBeUndefined();
    expect(formatTagDate("")).toBeUndefined();
    expect(formatTagDate("not-a-date")).toBeUndefined();
  });
});

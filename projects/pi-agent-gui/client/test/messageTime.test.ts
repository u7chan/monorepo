// メッセージ時刻の表示整形 (#1281)。
//
// 表記は ja-JP 固定でブラウザの locale に依存させない。テストは timeZone と「今日」の
// 基準時刻を固定して、タイムゾーンや実行時刻に左右されない期待値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { messageFullTimeLabel, messageTimeLabel } from "../src/lib/messageTime";

const TZ = "Asia/Tokyo";
/** 2026-12-31 12:50 JST (今日 / 同じ年 / 別の年 の 3 分岐を 1 つの基準で作れる) */
const NOW = Date.parse("2026-12-31T03:50:00.000Z");

test("今日のメッセージは時刻だけを表示する", () => {
  assert.equal(messageTimeLabel(NOW, { timeZone: TZ, now: NOW }), "12:50");
  // 24 時間表記 (深夜は 00:xx)。2026-12-31 00:05 JST
  assert.equal(messageTimeLabel(Date.parse("2026-12-30T15:05:00.000Z"), { timeZone: TZ, now: NOW }), "00:05");
});

test("同じ年のメッセージは月日を表示する", () => {
  assert.equal(messageTimeLabel(Date.parse("2026-09-05T03:50:00.000Z"), { timeZone: TZ, now: NOW }), "9/5");
});

test("別の年のメッセージは年つきで表示する", () => {
  assert.equal(messageTimeLabel(Date.parse("2025-09-05T03:50:00.000Z"), { timeZone: TZ, now: NOW }), "2025/9/5");
});

test("ホバー用は年つきの完全な日時を曜日つきで返す", () => {
  assert.equal(messageFullTimeLabel(Date.parse("2026-09-05T03:50:00.000Z"), { timeZone: TZ }), "2026/9/5(土) 12:50");
  assert.equal(messageFullTimeLabel(NOW, { timeZone: TZ }), "2026/12/31(木) 12:50");
});

test("timeZone を差し替えると表示もそのタイムゾーンで決まる", () => {
  const at = Date.parse("2026-09-05T03:50:00.000Z");
  assert.equal(messageTimeLabel(at, { timeZone: "UTC", now: at }), "03:50");
  assert.equal(messageFullTimeLabel(at, { timeZone: "UTC" }), "2026/9/5(土) 03:50");
});

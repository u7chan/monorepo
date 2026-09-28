// チャットのスキルピッカー (popover) の幅・高さの上限と位置を DOM なしで固定する。
// 実ブラウザーでしか確かめられない「開いてもコンポーザーが伸びない」「画面外へ出ない」の根拠はここに置く。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SKILL_PICKER_MAX_HEIGHT,
  SKILL_PICKER_MAX_HEIGHT_COMPACT,
  SKILL_PICKER_WIDTH,
  skillPickerLayout,
  skillPickerLeft,
  skillPickerTop,
  skillPickerWidth,
} from "../src/lib/skillPicker";
import type { SessionSkillsState } from "../src/lib/sessionSkills";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SkillPicker } = await import("../src/components/composer/SkillPicker");

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const DESKTOP = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

test("skillPickerWidth は viewport が狭いときだけ余白を残して縮める", () => {
  assert.equal(skillPickerWidth(DESKTOP.width), SKILL_PICKER_WIDTH);
  assert.equal(skillPickerWidth(390), SKILL_PICKER_WIDTH, "余白 8px を残しても収まる幅はそのまま");
  assert.equal(skillPickerWidth(300), 284);
  assert.equal(skillPickerWidth(12), 0, "余白すら取れない幅でも負にしない");
});

test("skillPickerLayout はコンポーザーの上に開き、上限をそちら側の空きに合わせる", () => {
  // desktop: 入力欄の上に十分な空きがある → 上に開き、上限は 420px (viewport の 60%)
  assert.deepEqual(skillPickerLayout({ top: 700, bottom: 728 }, DESKTOP, false), {
    above: true,
    maxHeight: SKILL_PICKER_MAX_HEIGHT,
  });
  // compact: 上限が 320px に下がる (入力欄とメッセージを覆いすぎない)
  assert.deepEqual(skillPickerLayout({ top: 700, bottom: 736 }, COMPACT, true), {
    above: true,
    maxHeight: SKILL_PICKER_MAX_HEIGHT_COMPACT,
  });
});

test("skillPickerLayout は上に入らないときだけ下へ倒し、空きで高さを詰める", () => {
  // 画面の上端近くの欄 (ツールバーなど) では下へ倒す
  assert.deepEqual(skillPickerLayout({ top: 10, bottom: 38 }, DESKTOP, false), {
    above: false,
    maxHeight: SKILL_PICKER_MAX_HEIGHT,
  });
  // どちらも 160px 未満しか無いときは広い方 (上の 88px) を選び、そこに合わせて縮める
  assert.deepEqual(skillPickerLayout({ top: 100, bottom: 128 }, { width: 390, height: 200 }, true), {
    above: true,
    maxHeight: 88,
  });
  // 空きが 0 でも負にしない (高さ 0 の枠を出し、viewport の外へは出さない)
  assert.equal(skillPickerLayout({ top: 10, bottom: 14 }, { width: 390, height: 20 }, false).maxHeight, 0);
});

test("skillPickerLeft は欄の左端にそろえ、右端ではみ出す分だけ左へ寄せる", () => {
  assert.equal(skillPickerLeft({ left: 300 }, SKILL_PICKER_WIDTH, DESKTOP.width), 300);
  assert.equal(
    skillPickerLeft({ left: 1300 }, SKILL_PICKER_WIDTH, DESKTOP.width),
    DESKTOP.width - SKILL_PICKER_WIDTH - 8,
  );
  assert.equal(skillPickerLeft({ left: 0 }, SKILL_PICKER_WIDTH, DESKTOP.width), 8, "左端は余白の内側へ clamp する");
  // compact では幅いっぱい近くになるため、余白の左端へ寄る
  assert.equal(skillPickerLeft({ left: 340 }, skillPickerWidth(COMPACT.width), COMPACT.width), 42);
});

test("skillPickerTop は上に開くとき欄の上端から高さぶん戻し、viewport の内側へ clamp する", () => {
  assert.equal(skillPickerTop({ top: 700, bottom: 728 }, 400, true, DESKTOP.height), 296);
  assert.equal(skillPickerTop({ top: 700, bottom: 728 }, 150, false, DESKTOP.height), 732);
  // 高さが空きを超えても上端は余白の内側に残す (見切れる分は内部スクロールで出す)
  assert.equal(skillPickerTop({ top: 700, bottom: 728 }, 900, true, DESKTOP.height), 8);
});

test("popover は常時 mount し、トリガーと dialog の関係を属性で持つ", () => {
  const states: SessionSkillsState[] = [
    { status: "loading" },
    { status: "unavailable" },
    { status: "error", message: "503" },
    { status: "ready", skills: [], projectSkills: false },
    {
      status: "ready",
      skills: [
        {
          name: "writer",
          description: "文章を書く",
          scope: "user",
          location: "/workspace/.agents/skills/writer/SKILL.md",
          relativePath: ".agents/skills/writer/SKILL.md",
          disableModelInvocation: false,
          shadowed: false,
          shadowedBy: null,
          shadows: [],
        },
      ],
      projectSkills: true,
    },
  ];
  for (const state of states) {
    const closed = renderToStaticMarkup(
      createElement(SkillPicker, {
        state,
        rootCwd: "/workspace",
        compact: false,
        open: false,
        onOpenChange: () => {},
        onSelect: () => {},
        onReload: () => {},
      }),
    );
    // 本体は閉じていても DOM に居る (React の条件付き mount と native の開閉を二重管理しない)
    assert.ok(closed.includes('popover="auto"'), "popover を常時 mount していない");
    assert.ok(closed.includes('role="dialog"'), "ポップアップが dialog でない");
    assert.ok(closed.includes('aria-expanded="false"'), "トリガーの開閉状態が出ていない");
    assert.ok(closed.includes('aria-haspopup="dialog"'), "トリガーが開くものの種別を出していない");
    // 一覧があるときだけ、選択で入るコマンドと場所 (title) を出す
    const hasList = state.status === "ready" && state.skills.length > 0;
    assert.equal(
      closed.includes("を /skill: として入力"),
      hasList,
      hasList ? "選択の行が出ていない" : "一覧が無いのに選択の行を出している",
    );
    if (hasList) {
      assert.ok(closed.includes("/skill:writer"), "行に挿入するコマンドが出ていない");
      assert.ok(closed.includes(".agents/skills/writer/SKILL.md"), "置き場が title に無い");
      assert.ok(closed.includes("本文は送信時に読み直します"), "本文の注記が出ていない");
    }
  }
  // 失敗と 0 件はどちらも 1 行 + 再取得 (行は出さない)
  for (const state of [
    { status: "error", message: "503" } as SessionSkillsState,
    { status: "ready", skills: [], projectSkills: false } as SessionSkillsState,
  ]) {
    const markup = renderToStaticMarkup(
      createElement(SkillPicker, {
        state,
        rootCwd: "/workspace",
        compact: false,
        open: true,
        onOpenChange: () => {},
        onSelect: () => {},
        onReload: () => {},
      }),
    );
    assert.ok(markup.includes("再取得"), "状態の行に再取得が無い");
  }
  // 一覧があるときの再取得は出さない (成功時に常設ボタンを置かない)
  const ok = renderToStaticMarkup(
    createElement(SkillPicker, {
      state: {
        status: "ready",
        skills: [
          {
            name: "writer",
            description: "文章を書く",
            scope: "user",
            location: "/workspace/.agents/skills/writer/SKILL.md",
            relativePath: ".agents/skills/writer/SKILL.md",
            disableModelInvocation: false,
            shadowed: false,
            shadowedBy: null,
            shadows: [],
          },
        ],
        projectSkills: true,
      },
      rootCwd: "/workspace",
      compact: false,
      open: true,
      onOpenChange: () => {},
      onSelect: () => {},
      onReload: () => {},
    }),
  );
  assert.ok(!ok.includes("再取得"), "一覧が出ているのに再取得を常設している");
});

test("場所は本文へ出さず、説明は 1 行に切って title へ逃がす", () => {
  const picker = source("../src/components/composer/SkillPicker.tsx");
  assert.ok(picker.includes("truncate"), "説明を 1 行に切っていない");
  // 場所の行を持たない (3 行目は警告と手動のみの注記に空ける)
  assert.ok(!picker.includes("sessionSkillLocation(skill, rootCwd)}<"), "場所を本文の行として出している");
  assert.ok(picker.includes("[skill.description, location, warning]"), "全文を title へ逃がしていない");
});

test("Composer は開いたときに取り直し、送信が成立したら畳む", () => {
  const composer = source("../src/components/Composer.tsx");
  assert.ok(composer.includes("<SkillPicker"), "SkillPicker を使っていない");
  assert.ok(!composer.includes("landscape={landscape}"), "ポップアップに landscape を持ち込んでいる");
  // 開いたときだけ取り直す (閉じても再取得しない)
  assert.ok(/if \(open\) onReloadSkills\(\)/.test(composer), "開いたときに取り直していない");
  // 送信の成立で畳む (compact の Model / Effort と同じ合図)
  assert.ok(/if \(sending\) setSkillsOpen\(false\)/.test(composer), "送信で畳んでいない");
});

test("useSessionSkills の再取得は一覧を消さず、取得中は何もしない", () => {
  const hook = source("../src/hooks/useSessionSkills.ts");
  assert.ok(hook.includes("startSessionSkillsReload(previous)"), "再取得で前の一覧を保っていない");
  assert.ok(hook.includes("if (inFlightRef.current > 0) return"), "取得中の二重打ちを止めていない");
  // 一覧を消すのは取得キーが変わったとき (初回 / 切替) だけにする
  assert.ok(hook.includes(': { status: "loading" })'), "初回取得で読込表示にしていない");
});

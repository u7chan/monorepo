// 作業先の表示と、作業フォルダの導線 (既定オープン / compact のシートの閉じ方) の配線。
// client に DOM テスト基盤が無いため、バーと空状態の描画は react-dom/server、配線はソース走査で固定する。
//   1. 既定オープン (プロジェクト配下なら開) を適用するのは App の handleNewChat だけ。
//      起動時は常に未所属の新規会話なので閉で、派生 state (projects 一覧の到着や root の解決) を契機にしない
//   2. 作成先はプロジェクト行の ＋ だけが決める。サイドバーの「新しい会話」と起動は未所属、
//      エージェント切替は今見ている会話の作業先を引き継ぐ
//   3. サイドバー / ドロワー / エージェント切替の 3 入口は handleNewChat を通り、useSessions の
//      内部フォールバック (newChat の直接呼び出し 6 箇所) は通らない
//   4. compact のシートは Effect ではなく描画中の同期で閉じ、監視キーは compact / mainView / filesRoot
//      (route オブジェクト全体は比べない)
//   5. 作業フォルダの閉じる導線は押した面だけを閉じる (シートの close が desktop のパネルを閉じない)
//   6. landscape の作業先行は収縮 + 省略 (長いプロジェクト名でタイトルと固定幅のボタンを押し出さない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { CompactBar } from "../src/components/CompactBar";
import { Topbar } from "../src/components/Topbar";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import type { ChatScope } from "../src/lib/chatScope";

const IDLE: RuntimeStatus = { text: "", error: false };
const PROJECT_SCOPE: ChatScope = { label: "work/hello", project: true, root: "work/hello" };

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const app = read("src/App.tsx");
const sessions = read("src/hooks/useSessions.ts");
const chatArea = read("src/components/ChatArea.tsx");

/** `<Tag` から次の `/>` までの JSX ブロック (props の配線を見る) */
function jsxProps(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}`);
  assert.ok(start >= 0, `${tag} の JSX が見つからない`);
  const end = source.indexOf("/>", start);
  assert.ok(end > start, `${tag} の JSX の終端が見つからない`);
  return source.slice(start, end);
}

/** useEffect の呼び出し本体 (括弧の対応で切り出す)。見つけた数も返し、取りこぼしを検出できるようにする */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/useEffect\(/g)) {
    const open = source.indexOf("(", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          bodies.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

test("バーは作業先を出し、空状態の見出しは作業先の有無で分岐する", () => {
  const topbar = renderToStaticMarkup(
    createElement(Topbar, {
      scope: PROJECT_SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
    }),
  );
  assert.ok(topbar.includes("work/hello"), "作業先チップが出ていない");
  assert.ok(topbar.includes('title="work/hello"'), "チップに作業フォルダが出ていない");
  assert.ok(
    topbar.indexOf("LOCAL WORKSPACE") < topbar.indexOf("work/hello"),
    "チップが eyebrow より左にある (作業先は LOCAL WORKSPACE の右)",
  );

  const compact = renderToStaticMarkup(
    createElement(CompactBar, {
      mode: "portrait",
      title: "会話",
      agentName: "実装担当",
      scope: PROJECT_SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
      onOpenNav: () => {},
    }),
  );
  assert.ok(compact.includes("work/hello · 実装担当"), "作業先がエージェント名に前置されていない");

  // ChatArea は api.ts (location を読む) を引き込むため node では描画できない。見出しの分岐はソースで固定する
  assert.ok(
    chatArea.includes('{scope.project ? `${scope.label} で作業します` : "プロジェクトの相棒です"}'),
    "空状態の見出しが作業先になっていない",
  );
  assert.ok(
    chatArea.includes("コードを読んだり、ファイルを編集したり、コマンドを実行できます。"),
    "空状態の説明文が変わっている (プロジェクト配下でも同じ行を出す)",
  );
});

test("既定オープンを適用するのは handleNewChat だけ (起動時は未所属なので閉)", () => {
  const calls = app.match(/sessionFilesDefaultOpen\(/g) ?? [];
  assert.equal(calls.length, 1, "既定オープンの呼び出しが handleNewChat 以外にある");
  assert.ok(
    app.includes("const [sessionFilesOpen, setSessionFilesOpen] = useState(false);"),
    "起動時のパネルの初期値が閉ではない (作成先を保存して引き継いでいる)",
  );
  assert.ok(
    app.includes("setSessionFilesOpen(sessionFilesDefaultOpen({ compact, projectId: target }))"),
    "新規会話の入口が作成先で既定を決めていない",
  );
  // 派生 state (一覧の到着 / root の解決 / layout) を契機に開閉しない
  const bodies = effectBodies(app);
  assert.equal(bodies.length, (app.match(/useEffect\(/g) ?? []).length, "useEffect の抽出に失敗した");
  assert.ok(
    bodies.every((body) => !body.includes("sessionFiles")),
    "Effect (派生 state) を契機に作業フォルダを開閉している",
  );
});

test("作成先はプロジェクト行の ＋ でだけ決まる (「新しい会話」と起動は未所属)", () => {
  const projects = read("src/hooks/useProjects.ts");
  const sidebar = read("src/components/Sidebar.tsx");
  const projectRow = read("src/components/sidebar/ProjectRow.tsx");
  // 作成先を保存すると、起動や「新しい会話」が最後に開いたプロジェクトを引き継いでしまう
  assert.doesNotMatch(projects, /localStorage|u7agent-project/, "作成先を保存している");
  assert.ok(projects.includes('useState<string>("")'), "起動時の作成先が未所属ではない");
  // 引数の無い newChat は未所属へ戻す (内部フォールバックも同じ規則になる)
  assert.ok(sessions.includes('selectProject(nextProjectId ?? "");'), "newChat が作成先を未所属へ戻していない");
  // 「新しい会話」はプロジェクトを渡さない。渡すのはプロジェクト行の ＋ だけ
  assert.ok(sidebar.includes("onClick={() => newChat()}"), "「新しい会話」がプロジェクトを渡している");
  assert.ok(
    sidebar.includes("newChat(undefined, group.project.id)"),
    "プロジェクト行の ＋ がプロジェクトを渡していない",
  );
  assert.ok(!sidebar.includes("selectProject"), "サイドバーが作成先を選択している");
  // 行のクリックは折りたたみのトグル (作成先の選択を無くした)。子の SessionRow は自分の onSelect を持つ
  assert.ok(projectRow.includes("onClick={onToggle}"), "プロジェクト行のクリックが折りたたみになっていない");
  assert.doesNotMatch(projectRow, /^\s+onSelect[?:,]/m, "プロジェクト行が作成先を選択している");
  assert.doesNotMatch(projectRow, /^\s+selected[?:,]/m, "プロジェクト行が選択ハイライトを持っている");
  // App の入口は未所属を既定にし、エージェント切替だけ今の作業先を引き継ぐ
  assert.ok(app.includes('const target = projectId ?? "";'), "新規会話の既定が未所属になっていない");
  assert.ok(
    app.includes(
      'handleNewChat(agentId, app.sessionId === "" ? app.selectedProjectId : (activeSession?.projectId ?? ""));',
    ),
    "エージェント切替が今の作業先を引き継いでいない",
  );
});

test("新規会話の 3 入口は handleNewChat を通り、内部フォールバックは通らない", () => {
  assert.ok(app.includes("newChat: handleNewChat,"), "docked の Sidebar が handleNewChat を通っていない");
  assert.ok(app.includes("handleNewChat(agentId, projectId);"), "ドロワーの入口が handleNewChat を通っていない");
  assert.ok(app.includes("handleNewChat(agentId,"), "エージェント切替が handleNewChat を通っていない");
  assert.equal((app.match(/app\.newChat\(/g) ?? []).length, 1, "handleNewChat 以外から newChat を呼んでいる");
  // 内部フォールバック (開けない / 削除 / SSE 閉鎖 / リンク解決失敗) は useSessions が直接呼ぶ
  assert.equal(
    (sessions.match(/newChatRef\.current\(\)/g) ?? []).length,
    6,
    "useSessions の内部フォールバックの数が変わった (配線の前提を見直す)",
  );
  assert.ok(!sessions.includes("sessionFilesDefaultOpen"), "内部フォールバックが既定オープンを適用している");
});

test("compact の作業先行は長い名前でも収縮して省略される (固定幅のボタンを押し出さない)", () => {
  // プロジェクト名に長さ制限は無い。shrink-0 のままだと名前の分だけ右へ伸び、通知 / 作業フォルダを押し出す
  const html = renderToStaticMarkup(
    createElement(CompactBar, {
      mode: "landscape",
      title: "会話",
      agentName: "実装担当",
      scope: { label: `a-very-long-${"x".repeat(90)}`, project: true, root: "demo-project" },
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
      sessionFiles: { open: false, onToggle: () => {} },
      onOpenNav: () => {},
    }),
  );
  const span = /<span class="([^"]*max-w-1\/2[^"]*)"/.exec(html);
  assert.ok(span, "landscape の作業先行が見つからない");
  const classes = span[1].split(/\s+/);
  for (const name of ["max-w-1/2", "min-w-0", "shrink", "truncate"]) {
    assert.ok(classes.includes(name), `作業先行に収縮 / 省略のクラスが無い: ${name}`);
  }
  assert.ok(!classes.includes("shrink-0"), "作業先行が収縮できない (shrink-0)");
  // 固定幅のボタンは作業先行の後ろに残す (先に伸びる要素を置かない)
  assert.ok(html.indexOf("· 実装担当") < html.indexOf('aria-label="通知"'));
  assert.ok(html.indexOf('aria-label="通知"') < html.indexOf('aria-label="作業フォルダ"'));
});

test("作業フォルダの閉じる導線は押した面だけを閉じる", () => {
  // シートの close で desktop のパネルを閉じると、compact を往復しただけで開閉が変わる
  assert.ok(
    app.includes("const closeSessionFiles = useCallback(() => setSessionFilesOpen(false), []);"),
    "パネルだけを閉じる close が無い",
  );
  assert.ok(
    app.includes("const closeSessionFilesSheet = useCallback(() => setSessionFilesSheetOpen(false), []);"),
    "シートだけを閉じる close が無い",
  );
  const onCloseOf = (block: string): string => /onClose=\{(\w+)\}/.exec(block)?.[1] ?? "";
  assert.equal(onCloseOf(jsxProps(app, "SessionFilesPanel")), "closeSessionFiles", "パネルの close が違う");
  assert.equal(onCloseOf(jsxProps(app, "SessionFilesSheet")), "closeSessionFilesSheet", "シートの close が違う");
});

test("compact のシートは描画中の同期で閉じ、監視キーは compact / mainView / filesRoot", () => {
  assert.ok(
    app.includes(
      "if (sheetScope.compact !== compact || sheetScope.view !== mainView || sheetScope.root !== filesRoot) {",
    ),
    "シートを閉じる契機 (compact / mainView / filesRoot) が変わっている",
  );
  assert.ok(app.includes("setSessionFilesSheetOpen(false);"), "シートを閉じていない");
  assert.ok(app.includes("useState(() => ({ compact, view: mainView, root: filesRoot }))"), "監視キーの初期値が違う");
  // route オブジェクト全体を比べない (`/s/<id>` が `/` へ畳まれるだけでは閉じない)
  assert.ok(!app.includes("sheetScope.route") && !app.includes("[route]"), "route オブジェクトを監視している");
  // Effect で閉じると、子の showModal() が先に走って 1 フレーム modal が出る
  const bodies = effectBodies(app);
  assert.ok(
    bodies.every((body) => !body.includes("setSessionFilesSheetOpen")),
    "シートの開閉を Effect で行っている",
  );
  // 開閉は面ごとに分ける (compact で開いたシートが desktop のパネルに出ない)
  assert.ok(app.includes('const filesPanelOpen = !compact && filesRoot !== "" && sessionFilesOpen;'));
  assert.ok(app.includes('const filesSheetOpen = compact && filesRoot !== "" && sessionFilesSheetOpen;'));
  assert.equal((app.match(/\n\s+scope=\{scope\}/g) ?? []).length, 3, "作業先をバーと空状態へ渡していない");
});

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createBffApp } from "../src/app";
import { createSandboxToolClientFromEnv } from "../src/sandbox/client";
import { asPiBff, createStubPi } from "./stub-pi";

const root = process.env.U7AGENT_FIXTURE_ROOT;
if (!root?.startsWith("/tmp/u7agent-spaces-e2e-") || root.includes("..")) {
  throw new Error("U7AGENT_FIXTURE_ROOT は mktemp で作成した /tmp/u7agent-spaces-e2e-* を指定してください");
}
const cwd = join(root, "workspace");
const store = join(root, "store");
await mkdir(store, { recursive: true });
const workspace = createSandboxToolClientFromEnv(process.env);
if (!workspace) throw new Error("別プロセスの一時サンドボックス URL / token が必要です");
const pi = Object.assign(
  createStubPi({
    chunkDelayMs: 150,
    // live 行の受入用: 実モデルの代わりに investigate の呼び出しと進捗を流す
    investigateProgress: {
      prompt: "リポジトリの docs 構成を調べ、investigate の記述箇所を報告して",
      progress: [
        "grep -rn investigate docs/",
        "grep -rn investigate docs/\nREADME.md と subagent.md に記述があります",
        "grep -rn investigate docs/\nREADME.md と subagent.md に記述があります\n結論: 索引は docs/README.md、契約は docs/subagent.md にあります",
      ],
      result: "結論: 索引は docs/README.md、契約は docs/subagent.md にあります",
    },
    // live 行の枠・ホールド・畳みの受入用: 速い順次 + 並列の連続ツール呼び出し (本文に「連続ツール」で発動)
    toolBurst: [
      {
        prompt: "連続ツール",
        calls: [
          { name: "read", args: { path: "client/src/lib/liveToolCall.ts" }, at: 0, endAt: 120 },
          { name: "bash", args: { command: "pnpm -C client test:unit" }, at: 220, endAt: 400 },
          { name: "read", args: { path: "docs/frontend.md" }, at: 480, endAt: 620 },
          { name: "edit", args: { path: "client/src/components/Composer.tsx" }, at: 700, endAt: 900 },
          { name: "bash", args: { command: "git diff --stat" }, at: 980, endAt: 1080 },
          // 並列 (同じ時刻に始まる) の 2 件
          { name: "grep", args: { command: "grep -rn chat-live-reserve client/src" }, at: 1060, endAt: 1240 },
          { name: "read", args: { path: "client/src/styles/index.css" }, at: 1060, endAt: 1300 },
          { name: "bash", args: { command: "pnpm check" }, at: 1400, endAt: 1900 },
        ],
      },
      // 畳みはじめの窓に極端に短命な行が来る再現 (本文に「畳み窓」で発動)。
      // 1 本目が終わるとホールドが切れて箱が畳みはじめ、その 100ms 後に start と end が同じ時刻の行が
      // 届く。畳みはじめを解除しないとこの行は 900ms のホールドごと消える (docs/testing.md の受入項目)
      {
        prompt: "畳み窓",
        calls: [{ name: "bash", args: { command: "sleep 1" }, at: 0, endAt: 900 }],
        closingWindow: { afterMs: 100, name: "bash", args: { command: "echo in-closing-window" } },
      },
      // 生成バッジの受入用。実 API は呼ばず、generate_image / generate_speech が返す結果本文をそのまま流す
      // (docs/image-generation.md / docs/speech-generation.md の「チャットのバッジ」)。本文に Markdown 画像を
      // 置くので、モデル表示のキャプションの受入にも同じシナリオを使える
      {
        prompt: "画像バッジ",
        reply:
          "夜の駅のホームに立つ黒猫のイラストなのだ。\n\n" +
          "![夜の駅のホームに立つ黒猫](generated/night-platform-cat.png)\n\n" +
          "落ち着いた色に寄せてみたのだ。",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "夜の駅のホームに立つ黒猫、落ち着いた色調" },
            at: 0,
            endAt: 1200,
            result:
              "モデル: openai/gpt-image-2\n" +
              "画像を生成して保存しました: generated/night-platform-cat.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/night-platform-cat.png) で示してください。",
          },
        ],
      },
      // 本文を持たないターン (画像だけの回答)。バッジ行とツール履歴の下端罫線の間隔の受入用
      {
        prompt: "画像バッジ本文なし",
        reply: "",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "夜の駅のホームに立つ黒猫、落ち着いた色調" },
            at: 0,
            endAt: 1200,
            result:
              "モデル: openai/gpt-image-2\n" +
              "画像を生成して保存しました: generated/night-platform-cat.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/night-platform-cat.png) で示してください。",
          },
        ],
      },
      {
        prompt: "音声バッジ",
        calls: [
          {
            name: "generate_speech",
            args: { text: "夜のホームに、一匹の黒猫が座っています。" },
            at: 0,
            endAt: 900,
            result:
              "モデル: google/gemini-3.8-flash-tts\n" +
              "ボイス: Kore\n" +
              "音声を生成して保存しました: generated/night-platform-cat-intro.mp3\n" +
              "本文に示すときは、このパス (generated/night-platform-cat-intro.mp3) を示してください。",
          },
        ],
      },
      // モデル行を書く前のセッション (結果本文にモデル行が無い) の再現。F5 の復元でも何も出ないこと
      {
        prompt: "モデル行なし",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "昔の生成" },
            at: 0,
            endAt: 600,
            result:
              "画像を生成して保存しました: generated/legacy-cat.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/legacy-cat.png) で示してください。",
          },
        ],
      },
      // 失敗したカード (throw は結果本文を残さない) の再現
      {
        prompt: "生成失敗",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "混雑しているとき" },
            at: 0,
            endAt: 800,
            isError: true,
            result: "画像生成が混雑しています（レート制限またはプロバイダー障害）",
          },
        ],
      },
      // 1 つのターンで別モデルの画像を 2 枚。ヘッダは「複数モデル」、行はそれぞれのモデルになる
      {
        prompt: "複数モデル",
        reply: "2 枚できたのだ。\n\n![1 枚目](generated/cat-a.png)\n\n![2 枚目](generated/cat-b.png)",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "1 枚目" },
            at: 0,
            endAt: 1100,
            result:
              "モデル: openai/gpt-image-2\n" +
              "画像を生成して保存しました: generated/cat-a.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/cat-a.png) で示してください。",
          },
          {
            name: "generate_image",
            args: { prompt: "2 枚目" },
            at: 1200,
            endAt: 2300,
            result:
              "モデル: black-forest-labs/flux-2-pro\n" +
              "画像を生成して保存しました: generated/cat-b.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/cat-b.png) で示してください。",
          },
        ],
      },
      // 生成音声のプレイヤーの受入用。再生には実ファイルが要る (stub は結果本文しか流さない) ので、
      // 一時ワークスペースへ mp3 / wav を置いてから使う
      {
        prompt: "音声2本",
        calls: [
          {
            name: "generate_speech",
            args: { text: "夜のホームに、一匹の黒猫が座っています。" },
            at: 0,
            endAt: 900,
            result:
              "モデル: google/gemini-3.8-flash-tts\n" +
              "ボイス: Kore\n" +
              "音声を生成して保存しました: generated/night-platform-cat-intro.mp3\n" +
              "本文に示すときは、このパス (generated/night-platform-cat-intro.mp3) を示してください。",
          },
          {
            name: "generate_speech",
            args: { text: "同じ紹介文の wav 版です。" },
            at: 1000,
            endAt: 1900,
            result:
              "モデル: google/gemini-3.8-flash-tts\n" +
              "ボイス: Zephyr\n" +
              "音声を生成して保存しました: generated/night-platform-cat-intro.wav\n" +
              "本文に示すときは、このパス (generated/night-platform-cat-intro.wav) を示してください。",
          },
        ],
      },
      // モデル行を書く前のセッションの音声。パスは残っているがプレイヤーもバッジも出ない
      {
        prompt: "音声モデル行なし",
        calls: [
          {
            name: "generate_speech",
            args: { text: "昔の音声です。" },
            at: 0,
            endAt: 700,
            result:
              "音声を生成して保存しました: generated/legacy-intro.mp3\n" +
              "本文に示すときは、このパス (generated/legacy-intro.mp3) を示してください。",
          },
        ],
      },
      // 失敗した音声 (throw は結果本文を残さない) ではプレイヤーが出ない
      {
        prompt: "音声失敗",
        calls: [
          {
            name: "generate_speech",
            args: { text: "混雑しているとき" },
            at: 0,
            endAt: 800,
            isError: true,
            result: "音声生成が混雑しています（レート制限またはプロバイダー障害）",
          },
        ],
      },
      // 検索プロバイダーのチップの受入用。結果本文の 2 行目に provider 行を入れたものを流す
      // (docs/web-search.md の「チャットのチップ」)。実 API は呼ばない
      {
        prompt: "検索チップ",
        calls: [
          {
            name: "web_search",
            args: { query: "u7agent の web_search" },
            at: 0,
            endAt: 900,
            result:
              "現在日時: 2026-10-07 (Asia/Tokyo)\n" +
              "検索プロバイダー: Exa\n" +
              "出典:\n" +
              "[1] u7agent — https://example.test/u7agent\n" +
              "\n" +
              "[1] u7agent — https://example.test/u7agent\n抜粋です。",
          },
        ],
      },
      {
        prompt: "検索失敗",
        calls: [
          {
            name: "web_search",
            args: { query: "混雑しているとき" },
            at: 0,
            endAt: 800,
            isError: true,
            result:
              "現在日時: 2026-10-07 (Asia/Tokyo)\n" +
              "検索プロバイダー: Tavily\n" +
              "検索プロバイダーのAPIキーが未設定です。設定 → Web 検索 を開いて登録してください。",
          },
        ],
      },
      // 同じターンに生成と検索が混ざったときのヘッダ (生成モデルと provider のチップが同居する)
      {
        prompt: "検索と生成",
        calls: [
          {
            name: "generate_image",
            args: { prompt: "夜の駅のホームに立つ黒猫、落ち着いた色調" },
            at: 0,
            endAt: 600,
            result:
              "モデル: openai/gpt-image-2\n" +
              "画像を生成して保存しました: generated/night-platform-cat.png\n" +
              "本文に示すときは Markdown 画像 ![alt](generated/night-platform-cat.png) で示してください。",
          },
          {
            name: "web_search",
            args: { query: "夜のホームの写真" },
            at: 700,
            endAt: 1400,
            result:
              "現在日時: 2026-10-07 (Asia/Tokyo)\n" +
              "検索プロバイダー: Tavily\n" +
              "出典:\n" +
              "[1] Night platform — https://example.test/night-platform\n" +
              "\n" +
              "[1] Night platform — https://example.test/night-platform\n抜粋です。",
          },
        ],
      },
      // 別ターンでの再掲と cp したコピー。生成カードを 1 枚も流さないターンなのでキャプションが出ない
      {
        prompt: "画像再掲",
        reply:
          "前の画像をもう一度出すのだ。\n\n" +
          "![再掲](generated/night-platform-cat.png)\n\n" +
          "コピーはこちらなのだ。\n\n" +
          "![コピー](generated/cat-copy.png)",
      },
    ],
    // 自動 (preflight) 圧縮の受入用: 本文に「自動圧縮」を含めて送ると、user message を積む前に
    // 1 回だけ圧縮が走る (区切りとターン終端の両方が出る)
    preflightCompaction: { prompt: "自動圧縮", compaction: { reason: "threshold" } },
    // 手動圧縮の受入用: 1 回目は成功、2 回目は失敗 (too-small で区切りも所要時間も出ない)。
    // 3 回目以降は manualCompaction (未指定 = 成功) に戻る
    manualCompactions: [{ reason: "manual" }, { reason: "manual", failure: "too-small" }],
    // 履歴ページの窓 (50 item) より長いターンの受入用: 本文に「長いターン」を含めて送ると 1 run で
    // 本文あり応答を 55 件積む (完了後の F5 で結末が出ることを見る)
    longTurn: { prompt: "長いターン", rounds: 55, roundDelayMs: 120 },
  }),
  { cwd, sandboxConfigured: true },
);
// workspace を渡すと env 由来のサンドボックスは作られないため、引き継ぎの物理移動とメモの読み書きは別の口として渡す
// (渡さないと受入の「⋯ から会話を引き継ぐ」が必ず 503 になる)
const bff = await createBffApp({
  cwd,
  sessionStoreDir: store,
  workspace,
  moveSandbox: workspace,
  handoffSandbox: workspace,
  // 公開サービスの確認 (スペース削除の 409) も同じ口から引く。渡さないと削除が必ず 503 になる
  serveSandbox: workspace,
  pi: asPiBff(pi),
});
if (bff.projects.list().length === 0) {
  await workspace.createDir("normal-project");
  bff.projects.create({ cwd: "normal-project", name: "通常のプロジェクト" });
}
if (bff.store.list("default").length === 0) {
  const session = await bff.store.create({});
  await bff.store.setTitle(session.id, "通常の会話");
}
const server = serve({ fetch: bff.app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) || 17990 });
console.log(`[spaces fixture] stub pi / store: ${store} / workspace: ${cwd}`);
const shutdown = async () => {
  server.close();
  await bff.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

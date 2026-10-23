import type { ToolCard } from "../../lib/chatTypes";
import { cn } from "../../lib/cn";
import { fileTreeFetchPath } from "../../lib/fileTree";
import { resolveFileRef } from "../../lib/fileRef";
import { generationBadgesOf, type GenerationBadge, type GenerationInfo } from "../../lib/generationInfo";
import { GenerationCaption } from "../GenerationCaption";

/** 生成音声 1 件ぶんの再生情報 */
type SpeechPlayer = { key: string; src: string; label: string; caption?: GenerationInfo };

function speechPlayersOf(
  badges: readonly GenerationBadge[],
  {
    rootCwd,
    cwd,
    rawUrl,
    captions,
  }: {
    rootCwd: string;
    cwd: string;
    rawUrl: (rootRelativePath: string) => string;
    captions?: Map<string, GenerationInfo>;
  },
): SpeechPlayer[] {
  // 絶対パスの参照は rootCwd が要る。相対パスだけを先に出すと、同じターンで行の有無が混ざる
  if (rootCwd === "" || cwd === "") return [];
  const players: SpeechPlayer[] = [];
  for (const badge of badges) {
    const { kind, path } = badge.info;
    if ((kind !== "speech" && kind !== "bgm") || path === undefined) continue;
    const resolved = resolveFileRef(path, rootCwd, cwd);
    if (resolved === null) continue;
    const fetchPath = fileTreeFetchPath(cwd, resolved);
    const caption = captions?.get(fetchPath);
    players.push({
      key: badge.key,
      src: rawUrl(fetchPath),
      label: `${fetchPath} のプレビュー`,
      ...(caption === undefined ? {} : { caption }),
    });
  }
  return players;
}

/** 生成音声のプレイヤー。位置と出さない条件は docs/speech-generation.md#チャットのプレイヤー が正 */
export function SpeechPlayerList({
  cards,
  rootCwd,
  cwd,
  rawUrl,
  captions,
  singleColumn,
}: {
  cards: readonly ToolCard[];
  /** ワークスペース root の絶対パス (health.cwd)。未取得 ("") のときは出さない (絶対パスの参照に要る) */
  rootCwd: string;
  /** 選択中セッションの作業フォルダ (payload.cwd)。未確定 ("") は何も解決しない */
  cwd: string;
  /** 解決した root 相対パスから配信 URL を組む。App が版付きの関数を注入する */
  rawUrl: (rootRelativePath: string) => string;
  /** このターンの生成物の対応表 (root 相対パス → 生成情報)。未指定はキャプションを出さない */
  captions?: Map<string, GenerationInfo>;
  singleColumn: boolean;
}) {
  const players = speechPlayersOf(generationBadgesOf(cards), { rootCwd, cwd, rawUrl, captions });
  if (players.length === 0) return null;
  return (
    <div className={cn("grid", singleColumn ? "mt-2 gap-2" : "mt-2.5 gap-2.5")}>
      {players.map((player) => (
        <div key={player.key} className="min-w-0">
          <audio controls src={player.src} aria-label={player.label} className="w-full" />
          {player.caption === undefined ? null : <GenerationCaption info={player.caption} />}
        </div>
      ))}
    </div>
  );
}

import type { ToolCard } from "../../lib/chatTypes";
import { cn } from "../../lib/cn";
import { fileTreeFetchPath } from "../../lib/fileTree";
import { resolveFileRef } from "../../lib/fileRef";
import { generationBadgesOf, type GenerationBadge } from "../../lib/generationInfo";

/** 生成音声 1 件ぶんの再生情報 */
type SpeechPlayer = { key: string; src: string; label: string };

/** カードの並びから再生できる音声だけを取り出す (パスの解決は Markdown 画像と同じ 3 段) */
function speechPlayersOf(
  badges: readonly GenerationBadge[],
  { rootCwd, cwd, rawUrl }: { rootCwd: string; cwd: string; rawUrl: (rootRelativePath: string) => string },
): SpeechPlayer[] {
  const players: SpeechPlayer[] = [];
  for (const badge of badges) {
    const { kind, path } = badge.info;
    if (kind !== "speech" || path === undefined) continue;
    const resolved = resolveFileRef(path, rootCwd, cwd);
    if (resolved === null) continue;
    const fetchPath = fileTreeFetchPath(cwd, resolved);
    players.push({ key: badge.key, src: rawUrl(fetchPath), label: `${fetchPath} のプレビュー` });
  }
  return players;
}

/** 生成音声のプレイヤー。位置と出さない条件は docs/speech-generation.md#チャットのプレイヤー が正 */
export function SpeechPlayerList({
  cards,
  rootCwd,
  cwd,
  rawUrl,
  compact,
}: {
  cards: readonly ToolCard[];
  /** ワークスペース root の絶対パス (health.cwd)。未取得 ("") は絶対パスの参照を解決しない */
  rootCwd: string;
  /** 選択中セッションの作業フォルダ (payload.cwd)。未確定 ("") は何も解決しない */
  cwd: string;
  /** 解決した root 相対パスから配信 URL を組む。App が版付きの関数を注入する */
  rawUrl: (rootRelativePath: string) => string;
  compact: boolean;
}) {
  const players = speechPlayersOf(generationBadgesOf(cards), { rootCwd, cwd, rawUrl });
  if (players.length === 0) return null;
  return (
    <div className={cn("grid", compact ? "mt-2 gap-2" : "mt-2.5 gap-2.5")}>
      {players.map((player) => (
        <audio key={player.key} controls src={player.src} aria-label={player.label} className="w-full" />
      ))}
    </div>
  );
}

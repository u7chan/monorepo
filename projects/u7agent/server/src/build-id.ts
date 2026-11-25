/**
 * client と BFF が同じイメージから配られたかを見分ける版の識別子 (docs/architecture.md の「版の互換の範囲」)。
 * 既定はビルド時に決まる version + コミットの短縮 SHA で、検証用の fixture は `U7AGENT_BUILD_ID` で差し替える。
 * 空文字は「識別子が無い」で、client は版ずれの案内を出さない。
 */
import { readFileSync } from "node:fs";

export function serverBuildId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.U7AGENT_BUILD_ID?.trim();
  if (explicit) return explicit;
  // 版は client のビルドも同じ package.json から読む (片方だけ書き写すと、版が進んだ側だけが黙って変わる)
  const version = packageVersion();
  const commit = (env.COMMIT_HASH ?? "").trim();
  if (version && commit) return `${version}+${commit}`;
  return version || commit;
}

function packageVersion(): string {
  try {
    const json = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof json.version === "string" ? json.version.trim() : "";
  } catch {
    return "";
  }
}

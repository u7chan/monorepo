// リンクの表示をサービス側から制御するためのラベル。
// ホスト名とポートだけでは HTTPS かどうかを判断できないため、TLS 終端の有無を
// portal の推測に頼らず compose 定義側で表明できるようにする。
const URL_LABEL = "portal.url";
const URL_LABEL_PREFIX = `${URL_LABEL}.`;
const HIDDEN_LABEL = "portal.hidden";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * docker ps の Labels（カンマ区切り）から compose project を読む。
 * deploy target は compose の -p で付く project 名と同じ。
 */
export function parseComposeProject(labels: string | undefined): string | undefined {
  if (!labels) return undefined;

  for (const pair of labels.split(",")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== COMPOSE_PROJECT_LABEL) continue;

    const value = pair.slice(index + 1).trim();
    return value || undefined;
  }

  return undefined;
}

export interface ContainerLinks {
  /** 単一の入口。`portal.url` を付けたコンテナは公開ポートのタイルを出さない */
  url?: string;
  /** 複数オリジン用の上書き。キーは公開ポート（publish をやめても識別子として残る） */
  urls?: Record<number, string>;
  /** インフラ用。リンクを出さない */
  hidden?: boolean;
}

/**
 * `portal.url` / `portal.url.<ポート>` / `portal.hidden` を 1 回の走査で読む
 */
export function parseLinkLabels(labels: string | undefined): ContainerLinks {
  const links: ContainerLinks = {};
  if (!labels) return links;

  let urls: Record<number, string> | undefined;
  for (const pair of labels.split(",")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;

    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (key === HIDDEN_LABEL) {
      // 真偽値の表現を増やさない。compose 側は "true" だけを使う。
      if (value.toLowerCase() === "true") links.hidden = true;
      continue;
    }

    if (key === URL_LABEL) {
      if (value) links.url = value;
      continue;
    }

    if (!key.startsWith(URL_LABEL_PREFIX)) continue;

    const portText = key.slice(URL_LABEL_PREFIX.length);
    if (!/^\d+$/.test(portText)) continue;

    const port = Number(portText);
    if (port < 1 || port > 65535 || !value) continue;

    urls ??= {};
    urls[port] = value;
  }

  if (urls) links.urls = urls;
  return links;
}

/**
 * ブラウザから見た公開オリジン。TLS 終端をリバースプロキシへ置くと、BFF が見るリクエストの origin は
 * `http://<host>` のまま、ブラウザの Origin は `https://<host>` になる。ずれたままでは Origin 検査・
 * アプリ CSP の `frame-src`・プレビュー / サービスのリンクが壊れるため、その基準を env で差し替える。
 * 未設定は現行の挙動 (リクエスト自身の origin とポート) をそのまま使う。
 */
export type PublicOrigins = {
  /** アプリのオリジン (Origin 検査の追加の許可先) */
  appOrigin?: string;
  /** プレビュー オリジン (iframe の src と CSP の frame-src) */
  filePreviewOrigin?: string;
  /** サービス オリジン (サービスリンクと Location の書き換え) */
  serviceOrigin?: string;
};

/** env 名は解決の 1 箇所にだけ書く (起動ログも同じ名前を出す) */
const APP_ORIGIN_ENV = "PI_APP_ORIGIN";
const FILE_PREVIEW_ORIGIN_ENV = "PI_FILE_PREVIEW_ORIGIN";
const SERVICE_ORIGIN_ENV = "PI_PREVIEW_ORIGIN";

export type PublicOriginEnv = {
  PI_APP_ORIGIN?: string;
  PI_FILE_PREVIEW_ORIGIN?: string;
  PI_PREVIEW_ORIGIN?: string;
};

/** 3 つの env を起動時に 1 回だけ解決する。未設定の項目はキーごと落とす (undefined を渡さない) */
export function resolvePublicOrigins(env: PublicOriginEnv): PublicOrigins {
  const appOrigin = resolveOrigin(env.PI_APP_ORIGIN, APP_ORIGIN_ENV);
  const filePreviewOrigin = resolveOrigin(env.PI_FILE_PREVIEW_ORIGIN, FILE_PREVIEW_ORIGIN_ENV);
  const serviceOrigin = resolveOrigin(env.PI_PREVIEW_ORIGIN, SERVICE_ORIGIN_ENV);
  return {
    ...(appOrigin === undefined ? {} : { appOrigin }),
    ...(filePreviewOrigin === undefined ? {} : { filePreviewOrigin }),
    ...(serviceOrigin === undefined ? {} : { serviceOrigin }),
  };
}

/**
 * env の 1 値を解決する。未設定 (空文字・空白だけを含む) は未設定へ倒し、それ以外の不正値は起動時に止める
 * (誤った値は画面に出ず、リンクが開けないだけなので、起動時に気付けるようにする)。
 */
function resolveOrigin(value: string | undefined, envName: string): string | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${envName} は http(s) の絶対 URL で指定してください: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${envName} は http(s) の絶対 URL で指定してください: ${value}`);
  }
  // ブラウザから見た origin ではない値 (資格情報・パス・クエリ・フラグメント) は、黙って捨てずに止める。
  // 末尾の `/` だけは URL の正規化で落ちるので、そのまま受け取る
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${envName} にユーザー情報は指定できません: ${value}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${envName} にはパス / クエリ / フラグメントを指定できません: ${value}`);
  }
  return url.origin;
}

/** 起動ログの 1 行。設定済みが無ければ undefined (未設定では現行のログのまま) */
export function publicOriginsLogLine(origins: PublicOrigins): string | undefined {
  const entries: Array<[string, string | undefined]> = [
    [APP_ORIGIN_ENV, origins.appOrigin],
    [FILE_PREVIEW_ORIGIN_ENV, origins.filePreviewOrigin],
    [SERVICE_ORIGIN_ENV, origins.serviceOrigin],
  ];
  const parts: string[] = [];
  for (const [name, value] of entries) if (value !== undefined) parts.push(`${name}=${value}`);
  return parts.length === 0 ? undefined : parts.join(", ");
}

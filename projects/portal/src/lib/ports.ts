import type { PortMapping } from "../types/container";

/**
 * ポートリンクの遷移先。ホストは全カードで共通なので、カード側ではなく URL 組み立てで補う。
 * ラベルで URL が指定されたポートは、TLS などホスト名だけでは表せない接続先を優先する。
 */
export function buildPortUrl(host: string, publicPort: number, override?: string): string {
  return override ?? `http://${host}:${publicPort}`;
}

/**
 * ポート見出しの 2 行目。公開ポートと内部ポートが同じなら "/tcp" だけを返す。
 * 同じ数字を大小 2 回並べても読み手に増える情報がないため。
 */
export function describePort(port: PortMapping): string {
  return port.publicPort === port.privatePort
    ? port.protocol
    : `${port.privatePort}/${port.protocol}`;
}

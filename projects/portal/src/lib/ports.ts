import type { PortMapping } from "../types/container";

/**
 * ポートタイルの遷移先。ホストは全カードで共通なので、カード側ではなく URL 組み立てで補う。
 * ラベルで指定された URL は別のチップとして出すため、ここでは上書きを扱わない。
 */
export function buildPortUrl(host: string, publicPort: number): string {
  return `http://${host}:${publicPort}`;
}

/**
 * チップの表示名。上書き URL はホスト名だけを見せる（ポート番号は行き先を表さない）。
 */
export function describeUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * TLS 終端されたリンクかどうか。SSL 化の有無はラベルの有無ではなく scheme で決める。
 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
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

export interface LinkSlot {
  portNumber: number;
  // 上書き URL があるスロットは URL チップにする
  url?: string;
  // 公開ポートのスロットだけ port を持つ
  port?: PortMapping;
}

/**
 * チップの並びを決める。公開ポートと、公開をやめた上書きを同じポート番号の昇順に混ぜる。
 * 上書きのキーは publish をやめても識別子として残るため、公開されていないポートの
 * 上書きもチップとして残す。
 */
export function orderLinks(
  ports: PortMapping[],
  urls: Record<number, string> | undefined,
): LinkSlot[] {
  const overrides = urls ?? {};
  const publishedPorts = new Set(ports.map((port) => port.publicPort));

  return [
    ...ports.map((port) => ({
      portNumber: port.publicPort,
      url: overrides[port.publicPort],
      port,
    })),
    ...Object.entries(overrides)
      .map(([port, url]) => ({ portNumber: Number(port), url, port: undefined }))
      .filter(({ portNumber }) => !publishedPorts.has(portNumber)),
  ].sort((a, b) => a.portNumber - b.portNumber);
}

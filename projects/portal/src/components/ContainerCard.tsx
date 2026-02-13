// ContainerCard Component - 個別のコンテナ情報を表示するカード

import type { Container } from "../types/container";

interface ContainerCardProps {
  container: Container;
}

/**
 * ステータスに応じたバッジのスタイルを取得
 */
function getStatusBadgeClass(state: Container["state"]): string {
  const baseClasses =
    "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border";

  switch (state) {
    case "running":
      return `${baseClasses} bg-emerald-500/10 text-emerald-400 border-emerald-500/30`;
    case "exited":
    case "dead":
      return `${baseClasses} bg-red-500/10 text-red-400 border-red-500/30`;
    case "paused":
      return `${baseClasses} bg-yellow-500/10 text-yellow-400 border-yellow-500/30`;
    case "restarting":
      return `${baseClasses} bg-blue-500/10 text-blue-400 border-blue-500/30`;
    default:
      return `${baseClasses} bg-gray-500/10 text-gray-400 border-gray-500/30`;
  }
}

/**
 * ステータスに応じたドットのスタイルを取得
 */
function getStatusDotClass(state: Container["state"]): string {
  switch (state) {
    case "running":
      return "bg-emerald-400 animate-pulse";
    case "exited":
    case "dead":
      return "bg-red-400";
    case "paused":
      return "bg-yellow-400";
    case "restarting":
      return "bg-blue-400 animate-pulse";
    default:
      return "bg-gray-400";
  }
}

/**
 * ポートリンクをレンダリング
 */
function PortLinks({ ports }: { ports: Container["ports"] }) {
  if (ports.length === 0) {
    return <span className="text-xs text-slate-500 italic">No exposed ports</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {ports.map((port, index) => (
        <a
          key={`${port.publicPort}-${index}`}
          href={`http://localhost:${port.publicPort}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center px-2 py-1 rounded text-xs font-mono
                     bg-cyan-500/10 text-cyan-400 border border-cyan-500/30
                     hover:bg-cyan-500/20 hover:border-cyan-400/50
                     transition-all duration-200 group"
        >
          <span className="mr-1 opacity-70">{port.publicPort}</span>
          <span className="text-slate-500">→</span>
          <span className="ml-1 opacity-70">{port.privatePort}</span>
          <span className="ml-1 text-[10px] uppercase opacity-50">{port.protocol}</span>
          <svg
            className="ml-1 w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
        </a>
      ))}
    </div>
  );
}

/**
 * コンテナカードコンポーネント
 */
export function ContainerCard({ container }: ContainerCardProps) {
  const shortId = container.id.slice(0, 12);

  return (
    <div
      className="relative group rounded-xl border border-slate-700/50 bg-slate-800/50
                 backdrop-blur-sm overflow-hidden
                 hover:border-cyan-500/50 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)]
                 transition-all duration-300"
    >
      {/* グロー効果 */}
      <div
        className="absolute inset-0 bg-linear-to-br from-cyan-500/5 via-purple-500/5 to-pink-500/5
                   opacity-0 group-hover:opacity-100 transition-opacity duration-500"
      />

      <div className="relative p-5">
        {/* ヘッダー: 名前とステータス */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1 min-w-0 mr-3">
            <h3
              className="text-lg font-semibold text-slate-100 truncate
                         group-hover:text-cyan-400 transition-colors"
              title={container.name}
            >
              {container.name}
            </h3>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{shortId}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={getStatusDotClass(container.state)}>
              <span className="block w-2 h-2 rounded-full" />
            </span>
            <span className={getStatusBadgeClass(container.state)}>{container.state}</span>
          </div>
        </div>

        {/* イメージ情報 */}
        <div className="mb-4">
          <p className="text-sm text-slate-400">
            <span className="text-slate-500">Image:</span>{" "}
            <span className="font-mono text-slate-300">{container.image}</span>
          </p>
          <p className="text-sm text-slate-400 mt-1">
            <span className="text-slate-500">Status:</span> <span>{container.status}</span>
          </p>
        </div>

        {/* ポート情報 */}
        <div className="border-t border-slate-700/50 pt-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Ports</p>
          <PortLinks ports={container.ports} />
        </div>
      </div>
    </div>
  );
}

export default ContainerCard;

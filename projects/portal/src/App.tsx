// Docker Container Portal - メインアプリケーション

import { useState } from "react";
import "./index.css";
import { ContainerList } from "./components/ContainerList";
import type { ContainerFilter } from "./types/container";

/**
 * フィルターボタンコンポーネント
 */
function FilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
        ${
          active
            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            : "bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:border-slate-600 hover:text-slate-300"
        }
      `}
    >
      {label}
      {count !== undefined && (
        <span
          className={`
          ml-2 px-2 py-0.5 rounded-full text-xs
          ${active ? "bg-cyan-500/30 text-cyan-300" : "bg-slate-700/50 text-slate-500"}
        `}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * Dockerアイコンコンポーネント
 */
function DockerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185zm-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186zm0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.186.185.186zm-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186zm-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.186.186.186zm5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185zm-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185zm-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.12a.186.186 0 00-.185.185v1.888c0 .102.084.185.186.185zm-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185zm20.744 1.3c-.428-.047-.856-.075-1.286-.089-.21-.007-.421-.01-.631-.013-.167-.002-.333-.004-.5-.004l-.175.002c-.385.004-.769.012-1.153.024-.367.012-.733.027-1.098.047-.339.019-.678.042-1.015.069-.29.023-.578.049-.866.079-.22.022-.44.047-.658.073-.08.01-.16.02-.24.031v3.595c0 .26.21.472.471.472h14.715c.261 0 .472-.212.472-.472v-3.371c-.343-.061-.69-.114-1.039-.16-.456-.06-.916-.106-1.376-.14-.355-.026-.711-.046-1.067-.059-.418-.015-.836-.022-1.255-.022-.054 0-.109.001-.163.001-.227.002-.454.006-.681.013-.132.004-.264.009-.395.015zM3.936 15.15c.261 0 .472.212.472.472v3.597h14.715c.261 0 .471-.212.471-.472V15.35c0-.26-.21-.472-.471-.472H4.408a.472.472 0 00-.472.472v.001z" />
      <path d="M21.74 10.615c-.857-.19-1.717-.32-2.581-.398a25.11 25.11 0 00-1.298-.09c-.361-.018-.724-.03-1.087-.037-.293-.006-.586-.008-.879-.005-.213.002-.426.006-.639.012-.222.006-.444.015-.666.026-.228.011-.456.024-.684.04-.189.013-.377.028-.565.045-.119.01-.238.022-.357.034-.08.008-.16.017-.24.026v.008c.356-.024.712-.042 1.068-.054.401-.013.803-.02 1.204-.02.08 0 .16 0 .24.001.274.002.549.006.823.012.329.007.658.017.987.03.397.015.794.035 1.19.06.424.026.848.058 1.271.095.29.025.58.053.868.085.086.01.172.02.258.03z" />
    </svg>
  );
}

/**
 * メインアプリケーションコンポーネント
 */
export function App() {
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const isMockMode = process.env.USE_MOCK_DATA === "true";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800">
      {/* 背景パターン */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -right-1/2 w-full h-full bg-gradient-to-b from-cyan-500/5 to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -left-1/2 w-full h-full bg-gradient-to-t from-purple-500/5 to-transparent rounded-full blur-3xl" />
      </div>

      {/* ヘッダー */}
      <header className="relative border-b border-slate-800/50 backdrop-blur-xl bg-slate-900/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="relative">
                <DockerIcon className="w-8 h-8 text-cyan-400" />
                <div className="absolute inset-0 bg-cyan-400/20 blur-xl rounded-full" />
              </div>
              <div className="flex items-center gap-3">
                <div>
                  <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                    Docker Portal
                  </h1>
                  <p className="text-xs text-slate-500">Container Management</p>
                </div>
                {isMockMode && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    MOCK MODE
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <a
                href="https://github.com/docker"
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-colors"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* フィルターセクション */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <FilterButton
              active={filter === "all"}
              label="All"
              onClick={() => setFilter("all")}
            />
            <FilterButton
              active={filter === "running"}
              label="Running"
              onClick={() => setFilter("running")}
            />
            <FilterButton
              active={filter === "stopped"}
              label="Stopped"
              onClick={() => setFilter("stopped")}
            />
          </div>
        </div>

        {/* コンテナ一覧 */}
        <ContainerList filter={filter} refreshInterval={30000} />
      </main>

      {/* フッター */}
      <footer className="relative border-t border-slate-800/50 mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">
              Built with{" "}
              <span className="text-cyan-400">Bun</span> +{" "}
              <span className="text-blue-400">React</span> +{" "}
              <span className="text-cyan-300">Tailwind</span>
            </p>
            <p className="text-xs text-slate-600">
              Auto-refresh every 30 seconds
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;

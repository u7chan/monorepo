// Docker Container Portal - メインアプリケーション

import { useEffect, useState } from "react";
import "./index.css";
import { ContainerList } from "./components/ContainerList";
import portalLogo from "./logo.svg";
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
 * アプリロゴコンポーネント
 */
function PortalLogo({ className }: { className?: string }) {
  return (
    <div className="relative">
      <div className="absolute inset-0 rounded-full bg-cyan-400/20 blur-xl" />
      <img src={portalLogo} alt="" className={`relative ${className ?? ""}`} />
    </div>
  );
}

/**
 * メインアプリケーションコンポーネント
 */
export function App() {
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [isMockMode, setIsMockMode] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setIsMockMode(data.isMockMode))
      .catch(() => setIsMockMode(false));
  }, []);

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-slate-900 to-slate-800">
      {/* 背景パターン */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -right-1/2 w-full h-full bg-linear-to-b from-cyan-500/5 to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -left-1/2 w-full h-full bg-linear-to-t from-purple-500/5 to-transparent rounded-full blur-3xl" />
      </div>

      {/* ヘッダー */}
      <header className="border-b border-slate-800/50 backdrop-blur-xl bg-slate-900/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <PortalLogo className="w-9 h-9" />
              <div className="flex items-center gap-3">
                <div>
                  <h1 className="text-xl font-bold bg-linear-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
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
            <FilterButton active={filter === "all"} label="All" onClick={() => setFilter("all")} />
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
              Built with <span className="text-cyan-400">Bun</span> +{" "}
              <span className="text-blue-400">React</span> +{" "}
              <span className="text-cyan-300">Tailwind</span>
            </p>
            <p className="text-xs text-slate-600">Auto-refresh every 30 seconds</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;

// Docker Container Portal - メインアプリケーション

import "./index.css";
import { ContainerList } from "./components/ContainerList";
import { useConfig } from "./hooks/useConfig";
import portalLogo from "./logo.svg";

/**
 * アプリロゴ。SVG 自体が背景を持つため、発光やブラーは足さない。
 */
function PortalLogo() {
  return <img src={portalLogo} alt="" className="size-7 shrink-0" />;
}

/**
 * メインアプリケーションコンポーネント
 */
export function App() {
  const { config } = useConfig();
  const host = config?.host ?? "localhost";

  return (
    <div className="min-h-screen bg-ink-950">
      <header className="sticky top-0 z-40 border-b border-line bg-ink-950/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <PortalLogo />
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Portal</h1>
          </div>

          <div className="flex items-center gap-2">
            {config?.isMockMode && (
              <span className="inline-flex h-7 items-center rounded-md border border-dashed border-line-strong px-2 text-[11px] font-medium text-fg-2">
                Mock data
              </span>
            )}
            <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line px-2 text-[11.5px]">
              <span className="hidden text-fg-3 sm:inline">host</span>
              <span className="truncate font-mono text-fg-2">{host}</span>
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <ContainerList refreshInterval={30000} />
      </main>
    </div>
  );
}

export default App;

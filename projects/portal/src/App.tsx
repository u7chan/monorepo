// Docker Container Portal - メインアプリケーション

import "./index.css";
import { useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { ContainerList } from "./components/ContainerList";
import { SettingsSheet } from "./components/SettingsSheet";
import { useConfig } from "./hooks/useConfig";
import { useScrollPast } from "./hooks/useScrollPast";
import { useTheme } from "./hooks/useTheme";

// 設定シートの HTTPS リンクはブラウザから見た portal の入口。リクエストの Host からは
// TLS 終端の有無を判断できないため、deploy 側が公開している URL をここで持つ。
const PORTAL_HTTPS_URL = "https://portal.home.arpa";

// 大きいタイトルの行が、固定のバー (高さ 44px) の下へ隠れ始めるスクロール量
const TITLE_COLLAPSE_SCROLL = 36;

/**
 * メインアプリケーションコンポーネント
 */
export function App() {
  const { config } = useConfig();
  const { preference, setPreference } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const titleCollapsed = useScrollPast(TITLE_COLLAPSE_SCROLL);

  return (
    <div className="min-h-dvh">
      <AppHeader
        compact={titleCollapsed}
        settingsOpen={settingsOpen}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* 下端はスマホで浮かぶツールバーの分まで空ける */}
      <main className="page-gutter mx-auto max-w-6xl pb-[calc(104px+env(safe-area-inset-bottom))] md:pb-12">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 pb-3">
          <h1 className="text-large-title font-bold [overflow-wrap:anywhere] text-label">
            Containers
          </h1>
          {config?.isMockMode && (
            <span className="rounded-full border border-dashed border-label-3 px-2.5 py-0.5 text-caption font-medium text-label-2">
              Mock data
            </span>
          )}
        </div>

        <ContainerList refreshInterval={30000} />
      </main>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        host={config?.host ?? "localhost"}
        httpsUrl={PORTAL_HTTPS_URL}
        isMockMode={config?.isMockMode ?? false}
        preference={preference}
        onPreferenceChange={setPreference}
      />
    </div>
  );
}

export default App;

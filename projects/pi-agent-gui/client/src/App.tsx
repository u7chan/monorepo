import { useCallback, useEffect, useState } from "react";
import { ChatArea } from "./components/ChatArea";
import { CompactBar } from "./components/CompactBar";
import { Composer } from "./components/Composer";
import { ManagerScreen } from "./components/ManagerScreen";
import { NavSheet } from "./components/NavSheet";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAgentDesk } from "./hooks/useAgentDesk";
import { useLayoutMode } from "./hooks/useLayoutMode";

export default function App() {
  const desk = useAgentDesk();
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  const [managerOpen, setManagerOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // ManagerScreen の dialog close / 閉じるボタンへ渡す安定参照
  const closeManager = useCallback(() => setManagerOpen(false), []);

  // 回転やウィンドウ拡大で desktop shell に戻ったら、ドロワーは畳む
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  const handleSend = useCallback(
    (text: string) => {
      void desk.sendMessage(text);
    },
    [desk],
  );

  const handleStop = useCallback(() => {
    void desk.stopAgent();
  }, [desk]);

  const refreshCatalog = useCallback(async () => {
    const catalog = await desk.loadCatalog();
    void desk.refreshSessions();
    return catalog;
  }, [desk]);

  // --- nav (sidebar / drawer) ---

  const closeNav = useCallback(() => setNavOpen(false), []);

  const navProps = {
    catalog: desk.catalog,
    sessions: desk.sessions,
    sessionId: desk.sessionId,
    agentId: desk.agentId,
    cwd: desk.cwd,
    selectedAgent: desk.selectedAgent,
    newChat: desk.newChat,
    selectSession: (sessionId: string) => {
      if (sessionId !== desk.sessionId) void desk.selectSession(sessionId);
    },
    deleteSession: (sessionId: string) => {
      void desk.deleteSession(sessionId);
    },
    onOpenManager: () => setManagerOpen(true),
  };

  // ドロワーは選んだら閉じる。削除だけは confirm の後も開いたまま残す (連続操作しうる)
  const drawerProps = {
    ...navProps,
    newChat: (agentId?: string) => {
      closeNav();
      desk.newChat(agentId);
    },
    selectSession: (sessionId: string) => {
      closeNav();
      if (sessionId !== desk.sessionId) void desk.selectSession(sessionId);
    },
    onOpenManager: () => {
      closeNav();
      setManagerOpen(true);
    },
  };

  const activeSession = desk.sessions.find((item) => item.sessionId === desk.sessionId);
  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = desk.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || desk.selectedAgent?.name;

  return (
    <div
      className={[
        "grid h-dvh min-h-0 bg-base text-ink",
        // compact は main だけが子なので 1 行。desktop は sidebar + main の 2 カラム
        compact ? "grid-rows-[minmax(0,1fr)]" : "grid-cols-[252px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
      ].join(" ")}
    >
      {compact ? null : <Sidebar {...navProps} />}
      <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        {compactMode ? (
          <CompactBar
            mode={compactMode}
            title={barTitle}
            agentName={barAgentName}
            runtimeStatus={desk.runtimeStatus}
            onOpenNav={() => setNavOpen(true)}
          />
        ) : (
          <Topbar runtimeStatus={desk.runtimeStatus} modelDisplay={desk.modelDisplay} />
        )}
        <ChatArea bubbles={desk.chat.bubbles} compact={compact} onSuggestion={handleSend} />
        <Composer
          activity={desk.chat.activity}
          runtimeReady={desk.health?.ready !== false}
          sending={desk.sending}
          stopVisible={desk.stopVisible}
          queueDepth={desk.chat.queueDepth}
          settings={desk.composerSettings}
          mode={layout}
          onSend={handleSend}
          onStop={handleStop}
          onChangeModel={desk.changeModel}
          onChangeThinkingLevel={desk.changeThinkingLevel}
        />
      </main>
      {compact && navOpen ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}
      {managerOpen ? (
        <ManagerScreen
          compact={compact}
          onClose={closeManager}
          catalog={desk.catalog}
          agentId={desk.agentId}
          refreshCatalog={refreshCatalog}
          modelOptions={desk.health?.modelOptions ?? []}
          defaultModel={desk.health?.model}
          defaultThinkingLevel={desk.health?.defaultThinkingLevel}
        />
      ) : null}
    </div>
  );
}

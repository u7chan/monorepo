import { useCallback, useState } from "react";
import { ChatArea } from "./components/ChatArea";
import { Composer } from "./components/Composer";
import { ManagerScreen } from "./components/ManagerScreen";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAgentDesk } from "./hooks/useAgentDesk";

export default function App() {
  const desk = useAgentDesk();
  const [managerOpen, setManagerOpen] = useState(false);
  // ManagerScreen の dialog close / 閉じるボタンへ渡す安定参照
  const closeManager = useCallback(() => setManagerOpen(false), []);

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

  return (
    <div className="grid h-dvh min-h-0 bg-base text-ink max-nav:grid-rows-[auto_minmax(0,1fr)] nav:grid-cols-[252px_minmax(0,1fr)] nav:grid-rows-[minmax(0,1fr)]">
      <Sidebar
        catalog={desk.catalog}
        sessions={desk.sessions}
        sessionId={desk.sessionId}
        agentId={desk.agentId}
        cwd={desk.cwd}
        selectedAgent={desk.selectedAgent}
        newChat={(agentId) => {
          void desk.newChat(agentId);
        }}
        selectSession={(id) => {
          void desk.selectSession(id);
        }}
        deleteSession={(id) => {
          void desk.deleteSession(id);
        }}
        onOpenManager={() => setManagerOpen(true)}
      />
      <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden max-nav:min-h-0">
        <Topbar runtimeStatus={desk.runtimeStatus} modelDisplay={desk.modelDisplay} />
        <ChatArea bubbles={desk.chat.bubbles} onSuggestion={handleSend} />
        <Composer
          activity={desk.chat.activity}
          runtimeReady={desk.health?.ready !== false}
          sending={desk.sending}
          stopVisible={desk.stopVisible}
          queueDepth={desk.chat.queueDepth}
          settings={desk.composerSettings}
          onSend={handleSend}
          onStop={handleStop}
          onChangeModel={desk.changeModel}
          onChangeThinkingLevel={desk.changeThinkingLevel}
        />
      </main>
      {managerOpen ? (
        <ManagerScreen
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

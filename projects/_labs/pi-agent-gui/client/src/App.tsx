import { useCallback, useState } from "react";
import { ChatArea } from "./components/ChatArea";
import { Composer } from "./components/Composer";
import { ManagerDialog } from "./components/ManagerDialog";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAgentDesk } from "./hooks/useAgentDesk";

export default function App() {
  const desk = useAgentDesk();
  const [managerOpen, setManagerOpen] = useState(false);

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
    // セッション一覧のエージェント名が変わることがあるため合わせて更新
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
        <Topbar runtimeStatus={desk.runtimeStatus} />
        <ChatArea bubbles={desk.chat.bubbles} onSuggestion={handleSend} />
        <Composer
          activity={desk.chat.activity}
          runtimeReady={desk.health?.ready !== false}
          sending={desk.sending}
          stopVisible={desk.stopVisible}
          queueDepth={desk.chat.queueDepth}
          onSend={handleSend}
          onStop={handleStop}
        />
      </main>
      <ManagerDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        catalog={desk.catalog}
        agentId={desk.agentId}
        refreshCatalog={refreshCatalog}
      />
    </div>
  );
}

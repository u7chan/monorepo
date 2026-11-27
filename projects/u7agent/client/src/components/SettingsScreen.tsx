import type { ReactElement } from "react";
import type { CatalogResponse, SessionSummary } from "../types";
import type { U7Agent } from "../hooks/useU7Agent";
import { settingsTabOf, type Route } from "../lib/route";
import type { SettingsSection, SettingsSubsection, SettingsTabSection } from "../lib/settingsNav";
import { AgentSettingsPage } from "./AgentSettingsPage";
import { AppearancePage } from "./AppearancePage";
import { BackupSettingsPage } from "./BackupSettingsPage";
import { ContentSettingsPage } from "./ContentSettingsPage";
import { FileTreePage } from "./FileTreePage";
import { GitSettingsPage } from "./GitSettingsPage";
import { ModelSettingsPage } from "./ModelSettingsPage";
import { NotificationSettingsPage } from "./NotificationSettingsPage";
import { PromptSettingsPage } from "./PromptSettingsPage";
import { RuntimePage } from "./RuntimePage";
import { SessionTitleSettingsPage } from "./SessionTitleSettingsPage";
import type { SettingsPageProps } from "./SettingsPageLayout";
import { SharingSettingsPage } from "./SharingSettingsPage";
import { SkillSettingsPage } from "./SkillSettingsPage";
import { SpaceSettingsPage } from "./SpaceSettingsPage";
import { VoiceInputSettingsPage } from "./VoiceInputSettingsPage";
import { WebSearchSettingsPage } from "./WebSearchSettingsPage";

export type SettingsScreenProps = {
  /** 表示するセクション。URL が正で、チャットのときは最後に開いていた値 (App が決める) */
  section: SettingsSection;
  /** タブの現在地 (settingsTabOf) を引く元。URL がただ 1 つの正 */
  route: Route;
  /** ページ共通の骨格 (singleColumn / 戻る / ドロワー) */
  page: SettingsPageProps;
  /** facade (useU7Agent)。各画面はここから自分の値だけを読む */
  app: U7Agent;
  /** 現在のスペースの会話一覧。最終使用の導出元として設定 → モデル / ランタイムへ渡す */
  sessions: SessionSummary[];
  /** カタログ (定義・マスタ・ツール) を取り直す。保存後の解決済みの値を追随させる */
  refreshCatalog: () => Promise<CatalogResponse>;
  /** ダウンロードの除外名 (設定 → ファイル) */
  excludeNames: readonly string[];
  /** 設定のタブ切替。URL へ集約するので App から受け取る */
  onOpenTab: <S extends SettingsTabSection>(section: S, subsection: SettingsSubsection<S>) => void;
  /** 設定面のリンクから会話へ移る (共有物の公開元 / ランタイムの起動元) */
  onOpenSession: (sessionId: string, spaceId?: string) => void;
  /** 会話スペースの画面から、会話を持たないチャットへ移る */
  onSelectSpace: () => void;
  /** 音声入力のキーの保存 / 削除。入力欄のマイクの可用性を取り直す */
  onVoiceInputKeyChanged: () => void;
};

/**
 * 設定のセクション → 画面。case の書き忘れは default の `satisfies never` が型エラーにする
 * (noImplicitReturns が無いため、union を足しただけでは気付けない)。値の取得はここで facade から。
 */
export function SettingsScreen({
  section,
  route,
  page,
  app,
  sessions,
  refreshCatalog,
  excludeNames,
  onOpenTab,
  onOpenSession,
  onSelectSpace,
  onVoiceInputKeyChanged,
}: SettingsScreenProps): ReactElement {
  switch (section) {
    case "spaces":
      return <SpaceSettingsPage {...page} onSelectSpace={onSelectSpace} />;
    case "agents":
      return (
        <AgentSettingsPage
          {...page}
          catalog={app.catalog}
          agentId={app.agentId}
          refreshCatalog={refreshCatalog}
          applyAgentOrder={app.applyAgentOrder}
          modelOptions={app.health?.modelOptions ?? []}
          defaultModel={app.health?.model}
          defaultThinkingLevel={app.health?.defaultThinkingLevel}
        />
      );
    case "prompts":
      // マスタの変更はエージェントへ解決済みの値として載るため、保存後にカタログを取り直す
      return <PromptSettingsPage {...page} refreshCatalog={refreshCatalog} applyPromptOrder={app.applyPromptOrder} />;
    case "skills":
      return (
        <SkillSettingsPage
          {...page}
          catalog={app.catalog}
          filePreviewPort={app.health?.filePreviewPort}
          filePreviewOrigin={app.health?.filePreviewOrigin}
          rootCwd={app.health?.cwd}
        />
      );
    case "files":
      // root を選択中の session / project に追随させると、選択を変えると同じ画面が別の場所を指して分かりにくい。
      // 設定のファイルはワークスペース全体に固定し、セッションの作業フォルダはツリーから辿って開く
      return (
        <FileTreePage
          {...page}
          cwd=""
          rootCwd={app.health?.cwd}
          excludeNames={excludeNames}
          filePreviewPort={app.health?.filePreviewPort}
          filePreviewOrigin={app.health?.filePreviewOrigin}
          archiveSettings={app.archiveSettings}
          filesSubsection={settingsTabOf(route, "files")}
          onSelectFilesSubsection={(subsection) => onOpenTab("files", subsection)}
          onOpenSharingExclusions={() => onOpenTab("sharing", "exclusions")}
        />
      );
    case "git":
      return <GitSettingsPage {...page} />;
    case "backup":
      // 復元 / 全削除はカタログ (定義とマスタ) を変えるため、成功後に取り直す
      return <BackupSettingsPage {...page} refreshCatalog={refreshCatalog} />;
    case "appearance":
      return (
        <AppearancePage
          {...page}
          appearanceSubsection={settingsTabOf(route, "appearance")}
          onSelectAppearanceSubsection={(subsection) => onOpenTab("appearance", subsection)}
        />
      );
    case "models":
      // 最終使用の導出元は facade が持つ一覧。この画面だけに渡す (再取得はしない)
      return (
        <ModelSettingsPage
          {...page}
          onRefreshHealth={app.refreshHealth}
          sessions={sessions}
          sessionsLoaded={app.sessionsLoaded}
          modelsSubsection={settingsTabOf(route, "models")}
          onSelectModelsSubsection={(subsection) => onOpenTab("models", subsection)}
        />
      );
    case "content":
      return (
        <ContentSettingsPage
          {...page}
          contentSubsection={settingsTabOf(route, "content")}
          onSelectContentSubsection={(subsection) => onOpenTab("content", subsection)}
          refreshToolCatalog={refreshCatalog}
        />
      );
    case "web-search":
      return <WebSearchSettingsPage {...page} refreshCatalog={refreshCatalog} />;
    case "voice-input":
      // 録音の入口は入力欄のマイク。キーの保存 / 削除で入力欄の可用性を取り直す
      return <VoiceInputSettingsPage {...page} onVoiceInputKeyChanged={onVoiceInputKeyChanged} />;
    case "session-title":
      // 本会話のモデルとは独立した設定なので、モデル画面の共有 state は渡さない (開いたときだけ取得する)
      return <SessionTitleSettingsPage {...page} />;
    case "runtime":
      return (
        <RuntimePage
          {...page}
          runtimeSubsection={settingsTabOf(route, "runtime")}
          onSelectRuntimeSubsection={(subsection) => onOpenTab("runtime", subsection)}
          health={app.health}
          onRefreshHealth={app.refreshHealth}
          sessions={sessions}
          openSessionId={app.sessionId}
          onOpenSession={onOpenSession}
        />
      );
    case "sharing":
      return (
        <SharingSettingsPage
          {...page}
          sessions={app.sessions}
          sessionsLoaded={app.sessionsLoaded && !app.sessionsFetch.failed}
          onOpenSession={onOpenSession}
          sharedContentExclusions={app.sharedContentExclusions}
          onOpenArchiveExclusions={() => onOpenTab("files", "archive")}
          sharingSubsection={settingsTabOf(route, "sharing")}
          onSelectSharingSubsection={(subsection) => onOpenTab("sharing", subsection)}
        />
      );
    case "notifications":
      return <NotificationSettingsPage {...page} notifications={app.notifications} />;
    default: {
      // 保存値も URL も SETTINGS_SECTIONS の既知の値だけを渡すため到達しない。
      // 空の設定画面を出すより、気付ける形で落とす
      section satisfies never;
      throw new Error(`未知の設定セクション: ${section}`);
    }
  }
}

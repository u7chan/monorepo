import { useState } from "react";
import { useCloudflareSettings } from "../hooks/useCloudflareSettings";
import type { SharedContentExclusionsSettings } from "../hooks/useSharedContentExclusions";
import { useSharedContentsManager, type SharedContentsManager } from "../hooks/useSharedContentsManager";
import { sharedContentFilterCounts, type SharedContentsFilter } from "../lib/sharedContents";
import { SHARING_SUBSECTIONS, type SharingSubsection } from "../lib/settingsNav";
import { UNSAVED_RELOAD_NOTE } from "../lib/settingsNotes";
import type { SessionSummary } from "../types";
import { CheckIcon } from "./icons";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { SettingsTabs } from "./SettingsTabs";
import { CloudflareCard } from "./sharing-settings/CloudflareCard";
import { SharedContentExclusionsTab } from "./sharing-settings/SharedContentExclusionsTab";
import { SharedContentsFilters } from "./sharing-settings/SharedContentsFilters";
import { SharedContentsTab } from "./sharing-settings/SharedContentsTab";
import { TabToolbar } from "./TabToolbar";

export type SharingSettingsPageProps = SettingsPageProps & {
  /** URL が決めるタブ。既定は共有コンテンツ */
  sharingSubsection: SharingSubsection;
  onSelectSharingSubsection: (subsection: SharingSubsection) => void;
  /** 公開の除外名の state と操作。プレビュー / 公開が使う実効値と同じものを編集する */
  sharedContentExclusions: SharedContentExclusionsSettings;
  /** 設定 → ファイル「ダウンロードの除外」へ移る（公開の除外との違いを文言で示す導線） */
  onOpenArchiveExclusions: () => void;
  /** 全スペースの会話。共有物の会話が一覧に無いときに「セッション（削除済み）」を出す */
  sessions: readonly SessionSummary[];
  /** 会話一覧がいま信頼できるか（初回取得に成功し、直近の取得が失敗していない）。
   * 信頼できない間は「削除済み」と言い切らず、更新も無効にしない */
  sessionsLoaded: boolean;
  /** 共有物の公開元の会話を開く。会話が見つからない共有物では呼ばれない */
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
};

/**
 * 設定 → 共有。共有コンテンツは公開した成果物の管理、公開の除外は公開対象から落とす名前、
 * 接続は Cloudflare の資格情報だけを扱う。取得と操作はそれぞれ contents / exclusions / cloudflare が持つ。
 */
export function SharingSettingsPage(props: SharingSettingsPageProps) {
  const cloudflare = useCloudflareSettings();
  const contents = useSharedContentsManager();
  return <SharingSettingsView {...props} cloudflare={cloudflare} contents={contents} />;
}

/** 表示だけを持つ部分。取得と変更は cloudflare / contents / exclusions が持ち、ここはタブと描画に徹する */
export function SharingSettingsView({
  cloudflare,
  contents,
  sharedContentExclusions,
  onOpenArchiveExclusions,
  sessions,
  sessionsLoaded,
  onOpenSession,
  sharingSubsection,
  onSelectSharingSubsection,
  singleColumn,
  onBack,
  onOpenNav,
}: SharingSettingsPageProps & {
  cloudflare: ReturnType<typeof useCloudflareSettings>;
  contents: SharedContentsManager;
}) {
  const [filter, setFilter] = useState<SharedContentsFilter>("all");
  // 追加前の入力はタブの親が持つ（本文はタブ切替で unmount されるため、子に置くと入力中の名前が消える）
  const [excludeInput, setExcludeInput] = useState("");
  const contentsTab = sharingSubsection === "contents";
  const exclusionsTab = sharingSubsection === "exclusions";
  const counts = sharedContentFilterCounts(contents.items);
  const { settings, dirty, saving, reloading, save, reset, discard } = sharedContentExclusions;
  const submitExcludeInput = () => {
    // 追加できなかったときは入力を残す（上限や重複の理由をその場で直せるように）
    if (sharedContentExclusions.add(excludeInput)) setExcludeInput("");
  };
  /** 下書きを捨てる再読み込みが押せない理由。変更が無い間は出さない */
  const unsavedReloadNote = exclusionsTab && dirty ? UNSAVED_RELOAD_NOTE : null;
  // 操作はタブごとに変える (一覧は取り直し、除外は下書きの保存、接続は登録状態の取り直し)
  const actions = contentsTab ? (
    <ReloadButton onClick={() => void contents.reload()} disabled={contents.reloading}>
      再読み込み
    </ReloadButton>
  ) : exclusionsTab ? (
    <>
      {/* 再読み込みは下書きを捨てるので、変更がある間は押せない (理由の置き場は下の caption / context) */}
      <ReloadButton onClick={() => void sharedContentExclusions.reload()} disabled={dirty || reloading}>
        再読み込み
      </ReloadButton>
      <span aria-hidden="true" className="h-4 w-px bg-line" />
      <button type="button" className="btn-quiet" disabled={!dirty || saving} onClick={discard}>
        破棄
      </button>
      <button
        type="button"
        className="btn-quiet"
        disabled={!settings?.overridden || saving}
        onClick={() => void reset()}
      >
        既定に戻す
      </button>
      <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
        <CheckIcon />
        保存
      </button>
    </>
  ) : (
    <ReloadButton onClick={() => void cloudflare.reload()} disabled={cloudflare.reloading}>
      再読み込み
    </ReloadButton>
  );
  return (
    <SettingsPageLayout
      eyebrow="SHARING"
      title="共有"
      caption={
        exclusionsTab ? (
          <>
            公開するときに対象から落とす名前を決めます。ダウンロードの除外（設定 → ファイル）とは別の一覧です。
            {/* singleColumn の帯は操作だけで埋まり、理由が 1 文字幅まで潰れる。ヘッダ側で折り返して読ませる */}
            {singleColumn && unsavedReloadNote ? (
              <div className="pt-0.5 text-2xs text-ink-muted">{unsavedReloadNote}</div>
            ) : null}
          </>
        ) : (
          "公開先の接続と、公開したコンテンツを管理します。"
        )
      }
      toolbar={
        <TabToolbar
          context={
            contentsTab && contents.items.length > 0 ? (
              // 空の一覧に 0 件のフィルタだけを並べない (空状態の案内を主にする)
              <SharedContentsFilters filter={filter} counts={counts} onSelect={setFilter} />
            ) : !singleColumn && unsavedReloadNote ? (
              <span className="text-2xs text-ink-muted">{unsavedReloadNote}</span>
            ) : undefined
          }
          actions={actions}
        />
      }
      tabs={
        <SettingsTabs
          items={SHARING_SUBSECTIONS}
          active={sharingSubsection}
          onSelect={onSelectSharingSubsection}
          ariaLabel="共有の設定"
          singleColumn={singleColumn}
        />
      }
      note={contentsTab ? undefined : exclusionsTab ? sharedContentExclusions.note : cloudflare.note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {contentsTab ? (
        <SharedContentsTab
          contents={contents}
          cloudflareConfigured={cloudflare.settings?.configured}
          sessions={sessions}
          sessionsLoaded={sessionsLoaded}
          filter={filter}
          onOpenConnections={() => onSelectSharingSubsection("connections")}
          onOpenSession={onOpenSession}
        />
      ) : exclusionsTab ? (
        <SharedContentExclusionsTab
          exclusions={sharedContentExclusions}
          input={excludeInput}
          onInputChange={setExcludeInput}
          onSubmit={submitExcludeInput}
          onOpenArchiveExclusions={onOpenArchiveExclusions}
        />
      ) : cloudflare.settings ? (
        <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-3xl gap-3">
            <CloudflareCard
              settings={cloudflare.settings}
              saving={cloudflare.saving}
              reloading={cloudflare.reloading}
              checking={cloudflare.checking}
              checkResult={cloudflare.checkResult}
              checkError={cloudflare.checkError}
              onSave={cloudflare.save}
              onDelete={cloudflare.remove}
              onCheck={cloudflare.check}
            />
          </div>
        </div>
      ) : (
        <SettingsPlaceholder label="Cloudflare の接続" note={cloudflare.note} />
      )}
    </SettingsPageLayout>
  );
}

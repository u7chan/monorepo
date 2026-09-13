import { useRef } from "react";
import { replaceCatalog } from "../api";
import type { Catalog } from "../types";
import { ExportIcon, ImportIcon } from "./icons";

/** メモリ内カタログの注意書き。エージェント / スキル両ページの初期ノートに使う */
export const DEFINITIONS_NOTE = "変更はこのサーバーのメモリ内だけに保存されます。再起動するとサンプルに戻ります。";

export type DefinitionTransferProps = {
  catalog: Catalog;
  /** カタログ再読込 (agentId の正規化も行われる) */
  refreshCatalog: () => Promise<Catalog>;
  /** 読み込んだ定義に合わせてページの選択を寄せる */
  onImported: (next: Catalog) => void;
  onNote: (text: string, error?: boolean) => void;
};

/**
 * カタログ全体 (エージェント + スキル) の書き出しと読み込み。
 * どちらの設定ページからも同じ操作をできるように共通化する。
 */
export function DefinitionTransfer({ catalog, refreshCatalog, onImported, onNote }: DefinitionTransferProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportDefinitions = () => {
    const body = JSON.stringify({ agents: catalog.agents, skills: catalog.skills }, null, 2);
    const blob = new Blob([body], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `agent-definitions-${date}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onNote("エージェントとスキルを書き出しました。");
  };

  const importDefinitions = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as { agents?: unknown }).agents) ||
        !Array.isArray((parsed as { skills?: unknown }).skills)
      ) {
        throw new Error("エージェントとスキルの配列を含むJSONを選択してください");
      }
      if (!window.confirm("現在のエージェントとスキルを読み込んだ定義で置き換えますか？")) return;

      const next = await replaceCatalog(parsed as { agents: unknown[]; skills: unknown[] });
      onImported(next);
      await refreshCatalog();
      onNote("読み込みました。適用するには新しい会話を開始してください。既存の会話は変更されません。");
    } catch (error) {
      onNote(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-quiet">
        <ImportIcon />
        インポート
      </button>
      <button type="button" onClick={exportDefinitions} className="btn-quiet">
        <ExportIcon />
        エクスポート
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void importDefinitions(file);
        }}
      />
    </>
  );
}

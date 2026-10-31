import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Space } from "server";
import App from "./App";
import { createSpace, createSpaceApi, deleteSpace, listSpaces, renameSpace, reorderSpaces } from "./api";
import { SpaceContext } from "./SpaceContext";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { reorderRows } from "./lib/agentReorder";
import { entrySpaceOf, parseRoute } from "./lib/route";
import type { HandoffNote } from "./lib/sessionHandoff";
import { removeSpaceAndApply } from "./lib/spaceDelete";
import { createSpaceRenameFlow, spaceRenameNoteText } from "./lib/spaceRename";
import { DEFAULT_SPACE_ID, initialSpaceSelection, selectedSpace, spaceSelectionStore } from "./lib/spaceSelection";

/** 読み取りの失敗は既定スペースを黙って出さず、明示的な選び直しを求める */
const SPACE_SELECTION_READ_ERROR = "会話スペースの選択を読み取れません。選び直してください。";

type SpaceSelectionState = {
  id: string;
  /** URL の `space` から決めたか。確定後に保存値も更新する */
  fromUrl: boolean;
  error: string;
};

/** URL → 保存値 → 既定。URL の `space` を読むのは会話を指定した URL (`/s/<id>`) の初期 mount の 1 回だけ */
function readInitialSelection(): SpaceSelectionState {
  try {
    const urlSpace = entrySpaceOf(parseRoute(window.location.pathname), window.location.search);
    return { ...initialSpaceSelection(urlSpace, spaceSelectionStore.read()), error: "" };
  } catch {
    return { id: "", fromUrl: false, error: SPACE_SELECTION_READ_ERROR };
  }
}

export function SpacesApp() {
  const [selection, setSelection] = useState(readInitialSelection);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  // 引き継ぎの警告 (履歴の片付けが残った)。スペースを選び直すと配下の App は作り直されるため、
  // 切替をまたいで残るここで持ち、移動先の App が状態行へ出してから消す
  const [handoffNote, setHandoffNote] = useState<HandoffNote | null>(null);
  // 選択の削除は await を挟むため、render 時の選択は古くなる。移り先の判定に使う最新の選択を ref でも持つ
  const selectionIdRef = useRef(selection.id);
  const applySelection = useCallback((next: SpaceSelectionState) => {
    selectionIdRef.current = next.id;
    setSelection(next);
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void listSpaces()
      .then(
        ({ spaces }) => {
          if (!current) return;
          setSpaces(spaces);
          setError("");
        },
        (error: unknown) => {
          if (current) setError(error instanceof Error ? error.message : "会話スペースを取得できません。");
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [reload]);
  const selected = selectedSpace(spaces, selection.id);
  useEffect(() => {
    // リンクで開いたスペースを次の初期表示にする (一覧に無い値は確定しないので保存もしない)
    if (!selection.fromUrl || !selected) return;
    spaceSelectionStore.write(selected.id);
  }, [selection.fromUrl, selected]);
  const select = useCallback(
    (id: string) => {
      if (!spaces.some((space) => space.id === id)) return;
      spaceSelectionStore.write(id);
      applySelection({ id, fromUrl: false, error: "" });
    },
    [spaces, applySelection],
  );
  const create = useCallback(async (name: string) => {
    const { space } = await createSpace(name);
    setSpaces((previous) => [...previous, space]);
  }, []);
  const remove = useCallback(
    async (id: string, onSelectionReset?: () => void) => {
      await removeSpaceAndApply(id, {
        removeSpace: deleteSpace,
        selectedId: () => selectionIdRef.current,
        forget: (removedId) => setSpaces((previous) => previous.filter((space) => space.id !== removedId)),
        navigateToChat: () => onSelectionReset?.(),
        persistSelection: (nextId) => spaceSelectionStore.write(nextId),
        select: (nextId) => applySelection({ id: nextId, fromUrl: false, error: "" }),
      });
    },
    [applySelection],
  );
  const reorder = useCallback(async (ids: readonly string[]) => {
    const { spaces: saved } = await reorderSpaces(ids);
    return saved.map((space) => space.id);
  }, []);
  // 改名はページを離れても続行する（前半の改名が後半の失敗で消えないよう待ち行列を持つ）ので、
  // 失敗の文言は一覧を持つここで受け、設定ページへ渡す
  const [renameNote, setRenameNote] = useState("");
  const [renameFlow] = useState(() =>
    createSpaceRenameFlow({
      save: async (id, name) => (await renameSpace(id, name)).space,
      apply: (space) => setSpaces((previous) => previous.map((item) => (item.id === space.id ? space : item))),
      note: (kind, message) => setRenameNote(spaceRenameNoteText(kind, message)),
    }),
  );
  const rename = useCallback((id: string, name: string) => renameFlow.rename(id, name), [renameFlow]);
  const clearRenameNote = useCallback(() => setRenameNote(""), []);
  // 応答の順をそのまま入れない: 既定スペースや、応答待ちの間に作られた行は元の位置に残す
  // (作成・削除は一覧を差分更新するので、遅れて届いた一覧全体で上書きしない)
  const applyOrder = useCallback((ids: readonly string[]) => {
    setSpaces((previous) => reorderRows(previous, ids));
  }, []);
  const api = useMemo(() => createSpaceApi(selected?.id ?? DEFAULT_SPACE_ID), [selected?.id]);
  if (loading || error || selection.error || !selected) {
    return (
      <main className="grid min-h-dvh content-start gap-4 bg-base p-6 text-ink">
        <h1 className="text-lg font-semibold">会話スペースを選択</h1>
        <p role="status">
          {loading
            ? "読み込み中…"
            : error || selection.error || "保存された会話スペースが見つかりません。選び直してください。"}
        </p>
        {!loading && !error
          ? spaces.map((space) => (
              <button type="button" className="btn-quiet" key={space.id} onClick={() => select(space.id)}>
                {space.name}
              </button>
            ))
          : null}
        {!loading ? (
          <button type="button" className="btn-quiet" onClick={() => setReload((value) => value + 1)}>
            会話スペースを再取得
          </button>
        ) : null}
      </main>
    );
  }
  return (
    <SpaceContext.Provider
      value={{
        spaces,
        selected,
        select,
        create,
        remove,
        reorder,
        applyOrder,
        rename,
        renameNote,
        clearRenameNote,
        api,
      }}
    >
      <ConfirmProvider key={selected.id}>
        <App handoffNote={handoffNote} onHandoffNoteShown={() => setHandoffNote(null)} onHandoffNote={setHandoffNote} />
      </ConfirmProvider>
    </SpaceContext.Provider>
  );
}

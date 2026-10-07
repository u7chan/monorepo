import { useCallback, useEffect, useMemo, useState } from "react";
import type { Space } from "server";
import App from "./App";
import { createSpace, createSpaceApi, listSpaces } from "./api";
import { SpaceContext } from "./SpaceContext";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { selectedSpace, readSpaceSelection, writeSpaceSelection } from "./lib/spaceSelection";

export function SpacesApp() {
  const [selection, setSelection] = useState(() => {
    try {
      return { id: readSpaceSelection(sessionStorage), error: "" };
    } catch {
      return { id: "", error: "このタブのスペース選択を読み取れません。選び直してください。" };
    }
  });
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
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
          if (current) setError(error instanceof Error ? error.message : "スペースを取得できません。");
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
  const select = useCallback(
    (id: string) => {
      if (!spaces.some((space) => space.id === id)) return;
      try {
        writeSpaceSelection(sessionStorage, id);
      } catch {
        /* 保存不能を理由に明示的な選び直しまで塞がない。 */
      }
      setSelection({ id, error: "" });
    },
    [spaces],
  );
  const create = useCallback(async (name: string) => {
    const { space } = await createSpace(name);
    setSpaces((previous) => [...previous, space]);
  }, []);
  const api = useMemo(() => createSpaceApi(selected?.id ?? "default"), [selected?.id]);
  if (loading || error || selection.error || !selected) {
    return (
      <main className="grid min-h-dvh content-start gap-4 bg-base p-6 text-ink">
        <h1 className="text-lg font-semibold">スペースを選択</h1>
        <p role="status">
          {loading
            ? "読み込み中…"
            : error || selection.error || "保存されたスペースが見つかりません。選び直してください。"}
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
            スペースを再取得
          </button>
        ) : null}
      </main>
    );
  }
  return (
    <SpaceContext.Provider value={{ spaces, selected, select, create, api }}>
      <ConfirmProvider key={selected.id}>
        <App />
      </ConfirmProvider>
    </SpaceContext.Provider>
  );
}

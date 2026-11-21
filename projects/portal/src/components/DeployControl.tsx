// イメージタグの選択 UI。デプロイはコンテナの再作成を伴うため、一覧の行を
// その場で展開し、対象のイメージのすぐ近くで確認できるようにする。

import { useEffect, useId, useRef, useState } from "react";
import type { DeployController } from "../hooks/useDeploy";
import { isOlderImageTag } from "../lib/image";
import { formatTagDateTime } from "../lib/tagDateTime";
import { ConfirmSheet } from "./ConfirmSheet";
import { ChevronUpDownIcon, DeployIcon } from "./icons";

export function DeployButton({ deploy }: { deploy: DeployController }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // パネルを閉じたとき、開く前に押したボタンへフォーカスを戻す。
  useEffect(() => {
    if (wasOpen.current && !deploy.isOpen) {
      buttonRef.current?.focus();
    }
    wasOpen.current = deploy.isOpen;
  }, [deploy.isOpen]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={deploy.toggle}
      disabled={deploy.pending}
      aria-expanded={deploy.isOpen}
      className={[
        "hit-area inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4",
        "text-subhead font-semibold text-label transition-[background-color,scale] duration-150 ease-ios",
        "can-hover:hover:bg-fill-strong active:scale-[0.97] active:bg-fill-strong",
        "disabled:cursor-not-allowed disabled:opacity-60",
        deploy.isOpen ? "bg-fill-strong" : "bg-fill",
      ].join(" ")}
    >
      {deploy.pending ? (
        <span
          aria-hidden="true"
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        <DeployIcon className="size-4" />
      )}
      <span>{deploy.pending ? "Deploying" : "Deploy"}</span>
    </button>
  );
}

const PLAIN_BUTTON =
  "min-h-10 rounded-full px-4 text-subhead font-medium text-accent transition-colors duration-150 can-hover:hover:bg-fill active:bg-fill disabled:cursor-not-allowed disabled:opacity-50";

export function DeployPanel({ deploy }: { deploy: DeployController }) {
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const successRef = useRef<HTMLAnchorElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 読み込み中は select が disabled で focus できない。有効になった時点で移す。
  useEffect(() => {
    if (!deploy.loading) {
      selectRef.current?.focus();
    }
  }, [deploy.loading]);

  // パネルが成功表示に切り替わると select が消えるため、次の操作先へフォーカスを移す。
  useEffect(() => {
    if (deploy.workflowUrl) {
      successRef.current?.focus();
    }
  }, [deploy.workflowUrl]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      deploy.close();
    }
  };

  if (deploy.workflowUrl) {
    return (
      <div onKeyDown={handleKeyDown} className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-subhead text-info">
          Deploy started.{" "}
          <a
            ref={successRef}
            href={deploy.workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            Open Actions
          </a>
        </p>
        <button type="button" onClick={deploy.close} className={`shrink-0 ${PLAIN_BUTTON}`}>
          Close
        </button>
      </div>
    );
  }

  const disabled =
    deploy.loading || deploy.pending || deploy.tags.length === 0 || !deploy.selectedTag;

  // 選択中の値は選択欄の幅に収まらず秒が切れることがあるため、作成日時は
  // 欄の外にも出して、開かなくても読めるようにする。
  const selectedCreatedAt = formatTagDateTime(
    deploy.tags.find((option) => option.tag === deploy.selectedTag)?.createdAt,
  );

  const rollingBack = isOlderImageTag(deploy.tags, deploy.currentTag, deploy.selectedTag);
  const rollbackDescription = [
    `The running image is ${deploy.currentTag}.`,
    selectedCreatedAt ? `This image was built ${selectedCreatedAt} (JST).` : null,
    "If the running image has migrated its database, the older code may fail to start or lose data.",
  ]
    .filter(Boolean)
    .join(" ");

  const handleDeploy = () => {
    if (rollingBack) {
      setConfirmOpen(true);
      return;
    }
    void deploy.submit();
  };

  return (
    <>
      {/* 確認シートは onKeyDown の外に置く。中に置くと、シートで押した Esc が親へ伝わり、
          シートと一緒にパネルまで閉じてしまう */}
      <div onKeyDown={handleKeyDown}>
        <label htmlFor={selectId} className="block text-footnote font-medium text-label-2">
          Image tag
        </label>
        <div className="relative mt-1.5">
          <select
            ref={selectRef}
            id={selectId}
            value={deploy.selectedTag}
            onChange={(event) => {
              setConfirmOpen(false);
              deploy.selectTag(event.target.value);
            }}
            disabled={deploy.loading || deploy.pending}
            className="min-h-11 w-full appearance-none overflow-hidden rounded-control bg-fill py-2 pr-10 pl-3 font-mono text-subhead text-ellipsis whitespace-nowrap text-label disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deploy.loading ? (
              <option value="">Loading tags…</option>
            ) : deploy.tags.length === 0 ? (
              <option value="">No tags found</option>
            ) : (
              deploy.tags.map((option) => {
                const createdAt = formatTagDateTime(option.createdAt);
                // 欄の幅に収まらないときは後ろから省略される。現在かどうかを日時より前に置いて残す
                const current = option.tag === deploy.currentTag ? " (current)" : "";
                return (
                  <option key={option.tag} value={option.tag}>
                    {`${option.tag}${current}${createdAt ? ` · ${createdAt}` : ""}`}
                  </option>
                );
              })
            )}
          </select>
          <ChevronUpDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-label-2" />
        </div>

        <p className="mt-2 text-footnote text-label-2">
          {selectedCreatedAt ? (
            <>
              Created at <span className="font-mono">{selectedCreatedAt}</span> (JST).{" "}
            </>
          ) : null}
          The container is recreated with the selected image.
        </p>
        {deploy.error && (
          <p role="alert" className="mt-2 text-footnote [overflow-wrap:anywhere] text-dead">
            {deploy.error}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={deploy.close}
            disabled={deploy.pending}
            className={PLAIN_BUTTON}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDeploy}
            disabled={disabled}
            aria-haspopup={rollingBack ? "dialog" : undefined}
            className="min-h-10 rounded-full bg-accent-fill px-5 text-subhead font-semibold text-white transition-[filter,scale] duration-150 ease-ios can-hover:hover:brightness-110 active:scale-[0.97] active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deploy.pending ? "Starting…" : "Deploy"}
          </button>
        </div>
      </div>

      {rollingBack && (
        <ConfirmSheet
          open={confirmOpen}
          title={`Roll back to ${deploy.selectedTag}?`}
          description={rollbackDescription}
          confirmLabel="Roll back"
          pending={deploy.pending}
          onConfirm={() => {
            setConfirmOpen(false);
            void deploy.submit();
          }}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

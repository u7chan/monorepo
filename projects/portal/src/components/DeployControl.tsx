// イメージタグの選択 UI。デプロイはコンテナの再作成を伴うため、一覧の行を
// その場で展開し、対象のイメージのすぐ近くで確認できるようにする。

import { useEffect, useId, useRef } from "react";
import type { DeployController } from "../hooks/useDeploy";

function DeployIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3"
    >
      <path d="M8 12V4" />
      <path d="m4.5 7.5 3.5-3.5 3.5 3.5" />
    </svg>
  );
}

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
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line px-2.5",
        "text-[11.5px] font-medium transition-colors duration-150",
        "hover:border-line-strong hover:bg-ink-800",
        "disabled:cursor-not-allowed disabled:opacity-50 text-fg-2 hover:text-fg",
      ].join(" ")}
    >
      {deploy.pending ? (
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border border-current border-t-transparent"
        />
      ) : (
        <DeployIcon />
      )}
      <span>{deploy.pending ? "Deploying" : "Deploy"}</span>
    </button>
  );
}

export function DeployPanel({ deploy }: { deploy: DeployController }) {
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const successRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

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
      <div onKeyDown={handleKeyDown}>
        <p className="text-[12px] text-info">
          Deploy started.{" "}
          <a
            ref={successRef}
            href={deploy.workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-fg"
          >
            Open Actions
          </a>
        </p>
        <button
          type="button"
          onClick={deploy.close}
          className="mt-2 h-8 rounded-md px-2.5 text-[12px] font-medium text-fg-2 transition-colors hover:bg-ink-700 hover:text-fg"
        >
          Close
        </button>
      </div>
    );
  }

  const disabled =
    deploy.loading || deploy.pending || deploy.tags.length === 0 || !deploy.selectedTag;

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-[11.5px] text-fg-3">
          Image tag
        </label>
        <select
          ref={selectRef}
          id={selectId}
          value={deploy.selectedTag}
          onChange={(event) => deploy.selectTag(event.target.value)}
          disabled={deploy.loading || deploy.pending}
          className="h-8 min-w-[14rem] flex-1 rounded-md border border-line bg-ink-900 px-2 font-mono text-[12px] text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deploy.loading ? (
            <option value="">Loading tags…</option>
          ) : deploy.tags.length === 0 ? (
            <option value="">No tags found</option>
          ) : (
            deploy.tags.map((option) => {
              const date = option.createdAt?.slice(5, 10);
              const current = option.tag === deploy.currentTag ? " (current)" : "";
              return (
                <option key={option.tag} value={option.tag}>
                  {`${option.tag}${date ? ` · ${date}` : ""}${current}`}
                </option>
              );
            })
          )}
        </select>
        <button
          type="button"
          onClick={() => void deploy.submit()}
          disabled={disabled}
          className="h-8 rounded-md border border-line px-3 text-[12px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-ink-800 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deploy.pending ? "Starting…" : "Deploy"}
        </button>
        <button
          type="button"
          onClick={deploy.close}
          disabled={deploy.pending}
          className="h-8 rounded-md px-2.5 text-[12px] font-medium text-fg-2 transition-colors hover:bg-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-fg-3">
        The container is recreated with the selected image.
      </p>
      {deploy.error && (
        <p role="alert" className="mt-1.5 text-[11px] text-dead">
          {deploy.error}
        </p>
      )}
    </div>
  );
}

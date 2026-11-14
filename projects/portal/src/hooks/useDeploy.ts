// イメージタグの取得とデプロイ起動を、カード/行の表示状態から分離する。
// タグ一覧は Deploy を開いたときだけ取り、30 秒の一覧更新では叩き直さない。

import { useCallback, useState } from "react";
import type {
  Container,
  DeployOptionsResponse,
  DeployResponse,
  ImageTagOption,
} from "../types/container";

export interface DeployController {
  isOpen: boolean;
  loading: boolean;
  pending: boolean;
  tags: ImageTagOption[];
  currentTag: string;
  selectedTag: string;
  error: string | null;
  workflowUrl: string | null;
  toggle: () => void;
  close: () => void;
  selectTag: (tag: string) => void;
  submit: () => Promise<void>;
}

function isTagOption(value: unknown): value is ImageTagOption {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).tag === "string"
  );
}

function readError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
    if (typeof record.error === "string" && record.error.length > 0) {
      return record.error;
    }
  }
  return fallback;
}

export function useDeploy(container: Container): DeployController {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [tags, setTags] = useState<ImageTagOption[]>([]);
  const [currentTag, setCurrentTag] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [workflowUrl, setWorkflowUrl] = useState<string | null>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setError(null);
  }, []);

  const loadOptions = useCallback(async () => {
    setIsOpen(true);
    setLoading(true);
    setError(null);
    setWorkflowUrl(null);

    try {
      const response = await fetch(
        `/api/containers/${encodeURIComponent(container.id)}/deploy-options`,
      );
      const body = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(readError(body, `Failed to load image tags (${response.status})`));
      }

      const data = body as Partial<DeployOptionsResponse> | null;
      const nextTags = Array.isArray(data?.tags) ? data.tags.filter(isTagOption) : [];
      const nextCurrent = typeof data?.currentTag === "string" ? data.currentTag : "";
      const hasCurrent =
        nextCurrent.length > 0 && nextTags.some((option) => option.tag === nextCurrent);

      // 現在のタグが一覧にない場合（latest は API で除外する）は、
      // 先頭の不変タグを初期選択にする。
      setTags(nextTags);
      setCurrentTag(nextCurrent);
      setSelectedTag(hasCurrent ? nextCurrent : (nextTags[0]?.tag ?? ""));
    } catch (loadError) {
      setTags([]);
      setSelectedTag("");
      setError(loadError instanceof Error ? loadError.message : "Failed to load image tags");
    } finally {
      setLoading(false);
    }
  }, [container.id]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    void loadOptions();
  }, [close, isOpen, loadOptions]);

  const submit = useCallback(async () => {
    if (!selectedTag || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ containerId: container.id, tag: selectedTag }),
      });
      const body = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(readError(body, `Deploy request failed (${response.status})`));
      }

      const data = body as Partial<DeployResponse> | null;
      setWorkflowUrl(typeof data?.workflowUrl === "string" ? data.workflowUrl : null);
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : "Deploy request failed");
    } finally {
      setPending(false);
    }
  }, [container.id, pending, selectedTag]);

  return {
    isOpen,
    loading,
    pending,
    tags,
    currentTag,
    selectedTag,
    error,
    workflowUrl,
    toggle,
    close,
    selectTag: setSelectedTag,
    submit,
  };
}

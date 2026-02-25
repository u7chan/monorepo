import type { UploadResponse, ExportRequest, PreviewRequest } from '@/types';

// ファイルアップロード
export async function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/upload', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`サーバーエラー: ${response.statusText}`);
  }

  return response.json();
}

// ビデオエクスポート
export async function exportVideo(request: ExportRequest): Promise<Blob> {
  const response = await fetch('/export', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`エクスポートに失敗しました: ${errorData.detail || response.statusText}`);
  }

  return response.blob();
}

// プレビュー画像生成
export async function generatePreview(request: PreviewRequest): Promise<Blob> {
  const response = await fetch('/preview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`プレビューの生成に失敗しました: ${errorData.detail}`);
  }

  return response.blob();
}

// キャッシュクリア
export async function clearCache(): Promise<void> {
  const response = await fetch('/clear-cache', { method: 'POST' });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`サーバーキャッシュのクリアに失敗しました: ${errorData.detail || response.statusText}`);
  }
}

// ファイル存在チェック
export async function checkFileExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

// Content-Dispositionからファイル名を抽出
export function extractFilename(disposition: string | null): string {
  if (!disposition || !disposition.includes('attachment')) {
    return 'exported_video.mp4';
  }

  const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
  const matches = filenameRegex.exec(disposition);

  if (matches?.[1]) {
    return matches[1].replace(/['"]/g, '');
  }

  return 'exported_video.mp4';
}

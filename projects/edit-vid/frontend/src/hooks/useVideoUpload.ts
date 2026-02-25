import { useState, useCallback } from 'react';
import { uploadFile, checkFileExists } from '@/api/client';
import { STORAGE_KEYS } from '@/types';

interface UseVideoUploadReturn {
  videoUrl: string | null;
  isUploading: boolean;
  error: string | null;
  uploadVideo: (file: File) => Promise<void>;
  clearVideo: () => void;
  restoreSession: () => Promise<boolean>;
}

export function useVideoUpload(): UseVideoUploadReturn {
  const [videoUrl, setVideoUrl] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEYS.videoUrl);
  });
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadVideo = useCallback(async (file: File) => {
    setIsUploading(true);
    setError(null);

    try {
      const result = await uploadFile(file);
      setVideoUrl(result.url);
      localStorage.setItem(STORAGE_KEYS.videoUrl, result.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'アップロードに失敗しました';
      setError(message);
      throw err;
    } finally {
      setIsUploading(false);
    }
  }, []);

  const clearVideo = useCallback(() => {
    setVideoUrl(null);
    localStorage.removeItem(STORAGE_KEYS.videoUrl);
  }, []);

  const restoreSession = useCallback(async () => {
    const lastVideoUrl = localStorage.getItem(STORAGE_KEYS.videoUrl);
    if (!lastVideoUrl) return false;

    const exists = await checkFileExists(lastVideoUrl);
    if (exists) {
      setVideoUrl(lastVideoUrl);
      return true;
    } else {
      // ファイルが存在しない場合はクリア
      localStorage.removeItem(STORAGE_KEYS.videoUrl);
      return false;
    }
  }, []);

  return {
    videoUrl,
    isUploading,
    error,
    uploadVideo,
    clearVideo,
    restoreSession,
  };
}

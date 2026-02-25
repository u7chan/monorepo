import { useState, useCallback, useEffect } from 'react';
import type { Subtitle, SubtitleSettings } from '@/types';
import { STORAGE_KEYS, DEFAULT_SUBTITLE_SETTINGS } from '@/types';
import { calculateDuration } from '@/utils/formatters';

export function useSubtitles(videoUrl: string | null) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [settings, setSettings] = useState<SubtitleSettings>(DEFAULT_SUBTITLE_SETTINGS);

  const filename = videoUrl?.split('/').pop() || null;
  const storageKey = filename ? STORAGE_KEYS.subtitlesPrefix + filename : null;

  // ローカルストレージからテロップを読み込む
  useEffect(() => {
    if (!storageKey) {
      setSubtitles([]);
      return;
    }

    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Subtitle[];
        setSubtitles(parsed);
      } catch {
        setSubtitles([]);
      }
    } else {
      setSubtitles([]);
    }
  }, [storageKey]);

  // ローカルストレージから設定を読み込む
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.subtitleSettings);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setSettings({
          fontSize: parsed.fontSize ?? DEFAULT_SUBTITLE_SETTINGS.fontSize,
          fontColor: parsed.fontColor ?? DEFAULT_SUBTITLE_SETTINGS.fontColor,
          boxColor: parsed.boxColor ?? DEFAULT_SUBTITLE_SETTINGS.boxColor,
          boxOpacity: parsed.boxOpacity ?? DEFAULT_SUBTITLE_SETTINGS.boxOpacity,
          isDurationFixed: parsed.isDurationFixed ?? DEFAULT_SUBTITLE_SETTINGS.isDurationFixed,
          fixedDuration: parsed.fixedDuration ?? DEFAULT_SUBTITLE_SETTINGS.fixedDuration,
        });
      } catch {
        setSettings(DEFAULT_SUBTITLE_SETTINGS);
      }
    }
  }, []);

  // テロップを保存
  const saveSubtitles = useCallback(
    (newSubtitles: Subtitle[]) => {
      // 開始時間でソート
      const sorted = [...newSubtitles].sort((a, b) => a.startTime - b.startTime);
      setSubtitles(sorted);
      if (storageKey) {
        localStorage.setItem(storageKey, JSON.stringify(sorted));
      }
    },
    [storageKey]
  );

  // 設定を保存
  const saveSettings = useCallback((newSettings: SubtitleSettings) => {
    setSettings(newSettings);
    localStorage.setItem(STORAGE_KEYS.subtitleSettings, JSON.stringify(newSettings));
  }, []);

  // テロップを追加
  const addSubtitle = useCallback(
    (text: string, currentTime: number, duration?: number) => {
      const actualDuration =
        duration ?? (settings.isDurationFixed ? settings.fixedDuration : calculateDuration(text));

      const newSubtitle: Subtitle = {
        id: Date.now(),
        text: text.trim(),
        startTime: currentTime,
        endTime: currentTime + actualDuration,
        duration: actualDuration,
      };

      saveSubtitles([...subtitles, newSubtitle]);
      return newSubtitle;
    },
    [subtitles, settings, saveSubtitles]
  );

  // テロップを更新
  const updateSubtitle = useCallback(
    (id: number, updates: Partial<Omit<Subtitle, 'id' | 'endTime'>>) => {
      const updated = subtitles.map((sub) => {
        if (sub.id !== id) return sub;

        const newDuration = updates.duration ?? sub.duration;
        return {
          ...sub,
          ...updates,
          endTime: (updates.startTime ?? sub.startTime) + newDuration,
        };
      });

      saveSubtitles(updated);
    },
    [subtitles, saveSubtitles]
  );

  // テロップを削除
  const deleteSubtitle = useCallback(
    (id: number) => {
      const filtered = subtitles.filter((sub) => sub.id !== id);
      saveSubtitles(filtered);
    },
    [subtitles, saveSubtitles]
  );

  // 特定のIDのテロップを取得
  const getSubtitleById = useCallback(
    (id: number) => {
      return subtitles.find((sub) => sub.id === id) ?? null;
    },
    [subtitles]
  );

  return {
    subtitles,
    settings,
    saveSettings,
    addSubtitle,
    updateSubtitle,
    deleteSubtitle,
    getSubtitleById,
  };
}

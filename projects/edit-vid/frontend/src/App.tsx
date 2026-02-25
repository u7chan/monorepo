import { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { VideoUploader } from './components/VideoUploader';
import { VideoEditor } from './components/VideoEditor';
import { ExportDialog } from './components/ExportDialog';
import { useVideoUpload } from './hooks/useVideoUpload';
import { useSubtitles } from './hooks/useSubtitles';
import { exportVideo, clearCache } from './api/client';
import { STORAGE_KEYS } from './types';

function App() {
  const {
    videoUrl,
    isUploading,
    uploadVideo,
    clearVideo,
    restoreSession,
  } = useVideoUpload();

  const {
    subtitles,
    settings,
    saveSettings,
    addSubtitle,
    updateSubtitle,
    deleteSubtitle,
  } = useSubtitles(videoUrl);

  const [isExporting, setIsExporting] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);

  // セッション復元
  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  // ファイルアップロードハンドラ
  const handleUpload = useCallback(
    async (file: File) => {
      try {
        await uploadVideo(file);
      } catch {
        // エラーはhook内で処理
      }
    },
    [uploadVideo]
  );

  // テロップ追加ハンドラ
  const handleAddSubtitle = useCallback(
    (text: string, duration: number, startTime: number) => {
      addSubtitle(text, startTime, duration);
    },
    [addSubtitle]
  );

  // テロップ更新ハンドラ
  const handleUpdateSubtitle = useCallback(
    (id: number, text: string, duration: number) => {
      const subtitle = subtitles.find((s) => s.id === id);
      if (subtitle) {
        updateSubtitle(id, { text, duration });
      }
    },
    [subtitles, updateSubtitle]
  );

  // エクスポートハンドラ
  const handleExport = useCallback(async () => {
    if (!videoUrl || subtitles.length === 0) return;

    const filename = videoUrl.split('/').pop();
    if (!filename) return;

    setIsExporting(true);
    setShowExportDialog(true);

    try {
      const blob = await exportVideo({
        filename,
        subtitles,
        fontSize: settings.fontSize,
        fontColor: settings.fontColor,
        boxColor: `${settings.boxColor}@${settings.boxOpacity}`,
      });

      // ファイルダウンロード
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = downloadUrl;
      a.download = 'exported_video.mp4';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      a.remove();

      setTimeout(() => {
        alert('ビデオのエクスポートが完了し、ダウンロードが開始されました。');
      }, 100);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'エクスポートに失敗しました');
    } finally {
      setIsExporting(false);
      setShowExportDialog(false);
    }
  }, [videoUrl, subtitles, settings]);

  // クリアハンドラ
  const handleClear = useCallback(async () => {
    if (
      confirm(
        '編集中のビデオ情報と、サーバー上のすべてのキャッシュ（アップロードされたファイルや出力ファイル）を削除してもよろしいですか？この操作は元に戻せません。'
      )
    ) {
      try {
        await clearCache();

        // ローカルストレージの関連データをすべてクリア
        Object.keys(localStorage).forEach((key) => {
          if (
            key === STORAGE_KEYS.videoUrl ||
            key.startsWith(STORAGE_KEYS.subtitlesPrefix) ||
            key === STORAGE_KEYS.subtitleSettings
          ) {
            localStorage.removeItem(key);
          }
        });

        clearVideo();
        alert('すべてのデータが正常にクリアされました。');
      } catch (error) {
        alert(error instanceof Error ? error.message : 'データクリアに失敗しました');
      }
    }
  }, [clearVideo]);

  return (
    <div className="flex flex-col h-screen">
      <Header
        hasVideo={!!videoUrl}
        hasSubtitles={subtitles.length > 0}
        onExport={handleExport}
        onClear={handleClear}
        isExporting={isExporting}
      />

      <main className="flex-1 flex items-center justify-center overflow-hidden">
        {!videoUrl ? (
          <VideoUploader onUpload={handleUpload} isUploading={isUploading} />
        ) : (
          <VideoEditor
            videoUrl={videoUrl}
            subtitles={subtitles}
            settings={settings}
            onAddSubtitle={handleAddSubtitle}
            onUpdateSubtitle={handleUpdateSubtitle}
            onDeleteSubtitle={deleteSubtitle}
            onSettingsChange={saveSettings}
          />
        )}
      </main>

      <ExportDialog isOpen={showExportDialog} />
    </div>
  );
}

export default App;

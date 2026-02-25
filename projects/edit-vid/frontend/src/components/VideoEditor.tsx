import { useRef, useState, useCallback } from 'react';
import type { Subtitle, SubtitleSettings } from '@/types';
import { VideoPlayer, type VideoPlayerRef } from './VideoPlayer';
import { SubtitleForm } from './SubtitleForm';
import { SubtitleSettings as SubtitleSettingsComponent } from './SubtitleSettings';
import { Timeline } from './Timeline';
import { EditDialog } from './EditDialog';
import { PreviewDialog } from './PreviewDialog';
import { generatePreview } from '@/api/client';

interface VideoEditorProps {
  videoUrl: string;
  subtitles: Subtitle[];
  settings: SubtitleSettings;
  onAddSubtitle: (text: string, duration: number, startTime: number) => void;
  onUpdateSubtitle: (id: number, text: string, duration: number) => void;
  onDeleteSubtitle: (id: number) => void;
  onSettingsChange: (settings: SubtitleSettings) => void;
}

export function VideoEditor({
  videoUrl,
  subtitles,
  settings,
  onAddSubtitle,
  onUpdateSubtitle,
  onDeleteSubtitle,
  onSettingsChange,
}: VideoEditorProps) {
  const videoRef = useRef<VideoPlayerRef>(null);

  // 編集ダイアログ
  const [editingSubtitle, setEditingSubtitle] = useState<Subtitle | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  // プレビューダイアログ
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isPreviewDialogOpen, setIsPreviewDialogOpen] = useState(false);

  const handleAddSubtitle = useCallback(
    (text: string, duration: number) => {
      // 現在の再生時刻を使用
      const startTime = videoRef.current?.getCurrentTime() ?? 0;
      onAddSubtitle(text, duration, startTime);
    },
    [onAddSubtitle]
  );

  const handleEdit = useCallback((id: number) => {
    const subtitle = subtitles.find((s) => s.id === id);
    if (subtitle) {
      setEditingSubtitle(subtitle);
      setIsEditDialogOpen(true);
    }
  }, [subtitles]);

  const handleSaveEdit = useCallback(
    (id: number, text: string, duration: number) => {
      onUpdateSubtitle(id, text, duration);
    },
    [onUpdateSubtitle]
  );

  const handleDelete = useCallback(
    (id: number) => {
      if (confirm('このテロップを削除してもよろしいですか？')) {
        onDeleteSubtitle(id);
      }
    },
    [onDeleteSubtitle]
  );

  const handlePreview = useCallback(
    async (id: number) => {
      const subtitle = subtitles.find((s) => s.id === id);
      if (!subtitle) return;

      const filename = videoUrl.split('/').pop();
      if (!filename) return;

      setIsPreviewDialogOpen(true);
      setPreviewImageUrl(null);

      try {
        const blob = await generatePreview({
          filename,
          text: subtitle.text,
          startTime: subtitle.startTime,
          duration: subtitle.duration,
          fontSize: settings.fontSize,
          fontColor: settings.fontColor,
          boxColor: `${settings.boxColor}@${settings.boxOpacity}`,
        });

        const url = URL.createObjectURL(blob);
        setPreviewImageUrl(url);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'プレビュー生成に失敗しました');
        setIsPreviewDialogOpen(false);
      }
    },
    [subtitles, videoUrl, settings]
  );

  return (
    <div id="editor-container" className="w-full h-full flex flex-col p-5 box-border">
      <div id="main-content" className="flex flex-1 gap-5 h-[65%]">
        <div id="video-preview-container" className="flex-[3] flex flex-col">
          <VideoPlayer ref={videoRef} src={videoUrl} />
        </div>
        <div
          id="actions-container"
          className="flex-1 border border-gray-300 rounded-lg p-5 bg-white flex flex-col overflow-y-auto box-border"
        >
          <SubtitleForm
            settings={settings}
            onAdd={handleAddSubtitle}
          />
          <hr className="my-5 border-t border-gray-300" />
          <SubtitleSettingsComponent settings={settings} onChange={onSettingsChange} />
        </div>
      </div>

      <Timeline
        subtitles={subtitles}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onPreview={handlePreview}
      />

      <EditDialog
        subtitle={editingSubtitle}
        isOpen={isEditDialogOpen}
        onClose={() => setIsEditDialogOpen(false)}
        onSave={handleSaveEdit}
      />

      <PreviewDialog
        imageUrl={previewImageUrl}
        isOpen={isPreviewDialogOpen}
        onClose={() => {
          setIsPreviewDialogOpen(false);
          if (previewImageUrl) {
            URL.revokeObjectURL(previewImageUrl);
            setPreviewImageUrl(null);
          }
        }}
      />
    </div>
  );
}

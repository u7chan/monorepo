import { useState, useEffect, useCallback } from 'react';
import type { Subtitle } from '@/types';
import { isValidSubtitleText, isValidDuration } from '@/utils/validators';
import { calculateDuration } from '@/utils/formatters';

interface EditDialogProps {
  subtitle: Subtitle | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: number, text: string, duration: number) => void;
}

export function EditDialog({ subtitle, isOpen, onClose, onSave }: EditDialogProps) {
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('');

  // ダイアログが開いたときに値を設定
  useEffect(() => {
    if (subtitle) {
      setText(subtitle.text);
      setDuration(String(subtitle.duration));
    }
  }, [subtitle, isOpen]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

    // 自動計算（編集時も）
    if (newText) {
      const calculated = calculateDuration(newText);
      setDuration(calculated.toFixed(1));
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      if (!subtitle) return;

      const trimmedText = text.trim();
      if (!isValidSubtitleText(trimmedText)) {
        alert('テロップのテキストを入力してください。');
        return;
      }

      const newDuration = parseFloat(duration);
      if (!isValidDuration(newDuration)) {
        alert('有効な表示時間を入力してください。');
        return;
      }

      onSave(subtitle.id, trimmedText, newDuration);
      onClose();
    },
    [subtitle, text, duration, onSave, onClose]
  );

  if (!isOpen || !subtitle) return null;

  return (
    <div
      id="edit-dialog"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg p-5 w-[80%] max-w-[800px] relative shadow-lg">
        <button
          onClick={onClose}
          className="absolute top-2.5 right-5 text-2xl text-gray-400 hover:text-black transition-colors"
        >
          &times;
        </button>

        <h3 className="text-lg font-bold mb-4">テロップ編集</h3>

        <form onSubmit={handleSubmit}>
          <label className="block mt-2.5 mb-1.5 font-bold text-sm">テキスト:</label>
          <textarea
            value={text}
            onChange={handleTextChange}
            rows={3}
            placeholder="表示するテキスト"
            className="w-full p-2 border border-gray-300 rounded text-sm box-border resize-y"
          />

          <label className="block mt-2.5 mb-1.5 font-bold text-sm">表示時間 (秒):</label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            placeholder="例: 2.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded text-sm box-border"
          />

          <button
            type="submit"
            id="save-edit-btn"
            className="w-full mt-4 px-4 py-2.5 rounded-md text-white font-medium text-base
                       bg-green-500 hover:bg-green-600 transition-colors"
          >
            保存
          </button>
        </form>
      </div>
    </div>
  );
}

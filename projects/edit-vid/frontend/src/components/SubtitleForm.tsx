import { useState, useCallback } from 'react';
import type { SubtitleSettings } from '@/types';
import { isValidSubtitleText, isValidDuration } from '@/utils/validators';
import { calculateDuration } from '@/utils/formatters';

interface SubtitleFormProps {
  settings: SubtitleSettings;
  onAdd: (text: string, duration: number) => void;
}

export function SubtitleForm({ settings, onAdd }: SubtitleFormProps) {
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('');
  const [isDurationFixed, setIsDurationFixed] = useState(settings.isDurationFixed);
  const [fixedDuration] = useState(String(settings.fixedDuration));

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setText(newText);

      // 固定表示時間でない場合、自動計算
      if (!isDurationFixed && newText) {
        const calculated = calculateDuration(newText);
        setDuration(calculated.toFixed(1));
      }
    },
    [isDurationFixed]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const trimmedText = text.trim();
      if (!isValidSubtitleText(trimmedText)) {
        alert('テロップのテキストを入力してください。');
        return;
      }

      const actualDuration = isDurationFixed
        ? parseFloat(fixedDuration)
        : parseFloat(duration);

      if (!isValidDuration(actualDuration)) {
        alert('有効な表示時間を入力してください。');
        return;
      }

      onAdd(trimmedText, actualDuration);

      // フォームをリセット
      setText('');
      if (!isDurationFixed) {
        setDuration('');
      }
    },
    [text, duration, isDurationFixed, fixedDuration, onAdd]
  );

  return (
    <div id="add-subtitle-container">
      <h3 className="text-lg font-bold mb-2.5">テロップ追加</h3>
      <form onSubmit={handleSubmit}>
        <label className="block mt-2.5 mb-1.5 font-bold text-sm">
          テキスト:
        </label>
        <textarea
          value={text}
          onChange={handleTextChange}
          rows={3}
          placeholder="表示するテキスト"
          className="w-full p-2 border border-gray-300 rounded text-sm box-border resize-y"
        />

        <label className="block mt-2.5 mb-1.5 font-bold text-sm">
          表示時間 (秒):
        </label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          placeholder="例: 2.5"
          value={isDurationFixed ? fixedDuration : duration}
          onChange={(e) => !isDurationFixed && setDuration(e.target.value)}
          disabled={isDurationFixed}
          className="w-full p-2 border border-gray-300 rounded text-sm box-border disabled:bg-gray-100"
        />

        <div className="mt-2">
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={isDurationFixed}
              onChange={(e) => {
                setIsDurationFixed(e.target.checked);
                if (e.target.checked) {
                  setDuration(fixedDuration);
                } else if (text) {
                  setDuration(calculateDuration(text).toFixed(1));
                }
              }}
              className="w-4 h-4 mr-2"
            />
            <span className="text-sm">表示時間を固定</span>
          </label>
        </div>

        <button
          type="submit"
          id="add-subtitle-btn"
          className="w-full mt-4 px-4 py-2.5 rounded-md text-white font-medium text-base
                     bg-green-500 hover:bg-green-600 transition-colors"
        >
          追加
        </button>
      </form>
    </div>
  );
}

import type { Subtitle } from '@/types';
import { formatTime, nl2br } from '@/utils/formatters';

interface TimelineProps {
  subtitles: Subtitle[];
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onPreview: (id: number) => void;
}

export function Timeline({ subtitles, onEdit, onDelete, onPreview }: TimelineProps) {
  return (
    <div id="timeline-container" className="mt-5 h-[calc(35%-20px)] overflow-y-auto border border-gray-300 rounded-lg bg-white">
      <table id="timeline-table" className="w-full border-collapse table-fixed">
        <thead className="sticky-header">
          <tr>
            <th className="w-[15%] border border-gray-300 px-2 py-3 text-left bg-gray-100 font-bold sticky top-0">
              開始時間
            </th>
            <th className="w-[15%] border border-gray-300 px-2 py-3 text-left bg-gray-100 font-bold sticky top-0">
              終了時間
            </th>
            <th className="w-[40%] border border-gray-300 px-2 py-3 text-left bg-gray-100 font-bold sticky top-0">
              テロップ
            </th>
            <th className="w-[15%] border border-gray-300 px-2 py-3 text-left bg-gray-100 font-bold sticky top-0">
              表示時間
            </th>
            <th className="w-[15%] border border-gray-300 px-2 py-3 text-left bg-gray-100 font-bold sticky top-0">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {subtitles.map((sub) => (
            <tr key={sub.id} data-id={sub.id}>
              <td className="border border-gray-300 px-2 py-3 align-middle">
                {formatTime(sub.startTime)}
              </td>
              <td className="border border-gray-300 px-2 py-3 align-middle">
                {formatTime(sub.endTime)}
              </td>
              <td
                className="border border-gray-300 px-2 py-3 align-middle whitespace-normal break-words"
                dangerouslySetInnerHTML={{ __html: nl2br(sub.text) }}
              />
              <td className="border border-gray-300 px-2 py-3 align-middle">
                {sub.duration.toFixed(1)}s
              </td>
              <td className="border border-gray-300 px-2 py-3 align-middle">
                <div className="flex gap-1 items-center">
                  <button
                    onClick={() => onEdit(sub.id)}
                    className="px-2.5 py-1.5 rounded text-xs text-white font-medium bg-green-500 hover:bg-green-600 transition-colors"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => onDelete(sub.id)}
                    className="px-2.5 py-1.5 rounded text-xs text-white font-medium bg-red-500 hover:bg-red-600 transition-colors"
                  >
                    削除
                  </button>
                  <button
                    onClick={() => onPreview(sub.id)}
                    className="px-2.5 py-1.5 rounded text-xs text-white font-medium bg-blue-500 hover:bg-blue-600 transition-colors"
                  >
                    プレビュー
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {subtitles.length === 0 && (
            <tr>
              <td colSpan={5} className="border border-gray-300 px-4 py-8 text-center text-gray-500">
                テロップが追加されていません
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

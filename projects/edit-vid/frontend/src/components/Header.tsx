interface HeaderProps {
  hasVideo: boolean;
  hasSubtitles: boolean;
  onExport: () => void;
  onClear: () => void;
  isExporting: boolean;
}

export function Header({ hasVideo, hasSubtitles, onExport, onClear, isExporting }: HeaderProps) {
  return (
    <header className="flex justify-between items-center px-5 py-3 bg-white border-b border-gray-300 shadow-sm z-10">
      <h1 className="text-2xl font-bold text-gray-800">EditVid</h1>
      {hasVideo && (
        <div className="flex gap-2.5">
          <button
            id="export-video-btn"
            onClick={onExport}
            disabled={!hasSubtitles || isExporting}
            className="px-4 py-2.5 rounded-md text-white text-sm font-medium transition-colors
                       bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isExporting ? 'エクスポート中...' : '出力'}
          </button>
          <button
            id="clear-video-btn"
            onClick={onClear}
            className="px-4 py-2.5 rounded-md text-white text-sm font-medium transition-colors
                       bg-red-500 hover:bg-red-600"
          >
            クリア
          </button>
        </div>
      )}
    </header>
  );
}

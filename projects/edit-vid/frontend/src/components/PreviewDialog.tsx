import { useState, useEffect } from 'react';

interface PreviewDialogProps {
  imageUrl: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function PreviewDialog({ imageUrl, isOpen, onClose }: PreviewDialogProps) {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
    }
  }, [isOpen, imageUrl]);

  if (!isOpen) return null;

  return (
    <div
      id="preview-dialog"
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

        <h3 className="text-lg font-bold mb-4">プレビュー</h3>

        <div className="relative min-h-[200px] flex items-center justify-center">
          {isLoading && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-lg text-gray-600">
              読み込み中...
            </div>
          )}
          {imageUrl && (
            <img
              src={imageUrl}
              alt="Subtitle Preview"
              className="max-w-full max-h-[70vh] block mx-auto"
              onLoad={() => setIsLoading(false)}
              style={{ display: isLoading ? 'none' : 'block' }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

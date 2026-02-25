import { useState, useRef, useCallback } from 'react';
import { isVideoFile } from '@/utils/validators';

interface VideoUploaderProps {
  onUpload: (file: File) => void;
  isUploading: boolean;
}

export function VideoUploader({ onUpload, isUploading }: VideoUploaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const file = e.dataTransfer.files[0];
      if (file && isVideoFile(file)) {
        onUpload(file);
      } else {
        alert('ビデオファイルを選択してください。');
      }
    },
    [onUpload]
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && isVideoFile(file)) {
        onUpload(file);
      } else if (file) {
        alert('ビデオファイルを選択してください。');
      }
    },
    [onUpload]
  );

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        border-2 border-dashed rounded-lg w-[50vw] max-w-[600px] min-h-[200px]
        flex flex-col items-center justify-center text-center p-5
        cursor-pointer bg-white transition-colors
        ${isDragOver ? 'bg-gray-100 border-gray-400' : 'border-gray-300'}
        ${isUploading ? 'opacity-50 cursor-wait' : ''}
      `}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={handleFileChange}
        className="hidden"
      />
      {isUploading ? (
        <>
          <div className="spinner mb-4" />
          <p className="text-gray-600">アップロード中...</p>
        </>
      ) : (
        <p className="text-gray-600">
          ビデオファイルをここにドロップするか、クリックして選択してください
        </p>
      )}
    </div>
  );
}

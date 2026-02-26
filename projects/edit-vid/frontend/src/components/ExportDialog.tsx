interface ExportDialogProps {
  isOpen: boolean;
}

export function ExportDialog({ isOpen }: ExportDialogProps) {
  if (!isOpen) return null;

  return (
    <div
      id="export-loading-dialog"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40"
    >
      <div className="bg-white rounded-lg p-8 w-[80%] max-w-[400px] text-center shadow-lg">
        <h3 className="text-xl font-bold mb-4">エクスポート中...</h3>
        <div className="spinner mx-auto mb-4" />
        <p className="text-gray-600">処理が完了するまでお待ちください。</p>
      </div>
    </div>
  );
}

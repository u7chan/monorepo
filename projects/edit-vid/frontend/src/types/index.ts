// テロップ（字幕）データ
export interface Subtitle {
  id: number;
  text: string;
  startTime: number;
  endTime: number;
  duration: number;
}

// テロップ設定
export interface SubtitleSettings {
  fontSize: number;
  fontColor: string;
  boxColor: string;
  boxOpacity: number;
  isDurationFixed: boolean;
  fixedDuration: number;
}

// アップロードレスポンス
export interface UploadResponse {
  url: string;
}

// エクスポートリクエスト
export interface ExportRequest {
  filename: string;
  subtitles: Subtitle[];
  fontSize: number;
  fontColor: string;
  boxColor: string;
}

// プレビューリクエスト
export interface PreviewRequest {
  filename: string;
  text: string;
  startTime: number;
  duration: number;
  fontSize: number;
  fontColor: string;
  boxColor: string;
}

// デフォルトのテロップ設定
export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  fontSize: 64,
  fontColor: '#FFFFFF',
  boxColor: '#000000',
  boxOpacity: 0.5,
  isDurationFixed: false,
  fixedDuration: 2.0,
};

// localStorageキー
export const STORAGE_KEYS = {
  videoUrl: 'lastUploadedVideoUrl',
  subtitlesPrefix: 'editvid_subtitles_',
  subtitleSettings: 'editvid_subtitle_settings',
} as const;

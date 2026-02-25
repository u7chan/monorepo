---
created: 2026-02-26
project: edit-vid
version: v1
previous_version: null
status: draft
---

# EditVid React + TypeScript + Tailwind CSS 移行計画

## Context
現在の `src/index.html` は HTML + CSS + JavaScript が1ファイル（約1100行）に混在しており、メンテナンス性が低い。React + TypeScript + Vite + Tailwind CSS の SPA 構成に移行して保守性と型安全性を向上させる。

## 目標構成
- React 19
- TypeScript 5.7+
- Vite 6+
- Tailwind CSS v4
- シンプルなSPA（ルーター不要）

## ディレクトリ構造
```
/edit-vid/
├── frontend/                    # React SPA ルート
│   ├── index.html               # Viteエントリーポイント
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   ├── postcss.config.js
│   └── src/
│       ├── main.tsx             # アプリケーションエントリーポイント
│       ├── App.tsx              # ルートコンポーネント
│       ├── index.css            # Tailwind CSS インポート
│       ├── types/
│       │   └── index.ts         # TypeScript型定義
│       ├── components/
│       │   ├── Header.tsx
│       │   ├── VideoUploader.tsx
│       │   ├── VideoEditor.tsx
│       │   ├── VideoPlayer.tsx
│       │   ├── SubtitleForm.tsx
│       │   ├── SubtitleSettings.tsx
│       │   ├── Timeline.tsx
│       │   ├── EditDialog.tsx
│       │   ├── PreviewDialog.tsx
│       │   └── ExportDialog.tsx
│       ├── hooks/
│       │   ├── useLocalStorage.ts
│       │   ├── useSubtitles.ts
│       │   └── useVideoUpload.ts
│       ├── utils/
│       │   ├── formatters.ts
│       │   └── validators.ts
│       └── api/
│           └── client.ts
├── src/                         # 既存のバックエンド（Python）
│   └── main.py
└── ...
```

## コンポーネント分割

| コンポーネント | 責務 |
|--------------|------|
| App.tsx | アプリケーション全体の状態管理、画面遷移制御 |
| Header.tsx | アプリタイトル、出力/クリアボタン |
| VideoUploader.tsx | ドラッグ&ドロップ対応ファイルアップロード |
| VideoEditor.tsx | エディタ画面レイアウト |
| VideoPlayer.tsx | HTML5 Video要素ラップ |
| SubtitleForm.tsx | テロップ追加フォーム |
| SubtitleSettings.tsx | テロップ設定（フォント、色） |
| Timeline.tsx | テロップ一覧テーブル |
| EditDialog.tsx | テロップ編集モーダル |
| PreviewDialog.tsx | プレビュー表示モーダル |
| ExportDialog.tsx | エクスポートローディングモーダル |

## 主要な型定義

```typescript
// types/index.ts

export interface Subtitle {
  id: number;
  text: string;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface SubtitleSettings {
  fontSize: number;
  fontColor: string;
  boxColor: string;
  boxOpacity: number;
  isDurationFixed: boolean;
  fixedDuration: number;
}

export interface UploadResponse {
  url: string;
}
```

## package.json

```json
{
  "name": "editvid-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@tailwindcss/postcss": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "postcss": "^8.4.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

## vite.config.ts

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/upload': 'http://localhost:8000',
      '/export': 'http://localhost:8000',
      '/preview': 'http://localhost:8000',
      '/clear-cache': 'http://localhost:8000',
      '/videos': 'http://localhost:8000',
      '/exports': 'http://localhost:8000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
```

## index.css

```css
@import "tailwindcss";

/* カスタムスタイル */
body {
  @apply bg-gray-100;
}

/* ドラッグ&ドロップ時のスタイル */
.dragover {
  @apply bg-gray-200 border-gray-400;
}

/* タイムラインの固定ヘッダー */
.sticky-header th {
  @apply sticky top-0 bg-gray-100;
}
```

## 実装ステップ

### Phase 1: プロジェクトセットアップ
1. `frontend/` ディレクトリ作成
2. `npm create vite@latest frontend -- --template react-ts` 実行
3. Tailwind CSS v4 をインストール
   ```bash
   npm install -D @tailwindcss/postcss tailwindcss postcss
   ```
4. `postcss.config.js` を作成
5. `vite.config.ts` に Tailwind プラグインとプロキシ設定を追加
6. `tsconfig.json` のパスエイリアス設定
7. `src/index.css` に `@import "tailwindcss"` を追加

### Phase 2: 基盤実装
8. `/frontend/src/types/index.ts` 作成
9. `/frontend/src/utils/` ユーティリティ関数作成
10. `/frontend/src/api/client.ts` APIクライアント作成

### Phase 3: カスタムフック
11. `useLocalStorage.ts` - localStorage永続化
12. `useSubtitles.ts` - テロップCRUD操作
13. `useVideoUpload.ts` - アップロード処理

### Phase 4: UIコンポーネント（Tailwind使用）
14. Header.tsx
15. VideoUploader.tsx
16. VideoPlayer.tsx
17. SubtitleForm.tsx
18. SubtitleSettings.tsx
19. Timeline.tsx
20. EditDialog.tsx
21. PreviewDialog.tsx
22. ExportDialog.tsx

### Phase 5: 統合
23. VideoEditor.tsx
24. App.tsx
25. main.tsx

### Phase 6: バックエンド調整
26. `main.py` の静的ファイル配信設定調整

## Critical Files

- `/frontend/src/types/index.ts` - 型定義の基盤
- `/frontend/src/hooks/useSubtitles.ts` - テロップ状態管理と永続化
- `/frontend/src/App.tsx` - アプリケーション全体の状態管理
- `/frontend/vite.config.ts` - 開発サーバーのプロキシ設定
- `/frontend/src/index.css` - Tailwind CSS 設定

## Tailwind CSS v4 の特徴

- PostCSS ベースの新しいエンジン
- `@import "tailwindcss"` でインポート
- 設定ファイル不要（デフォルト動作）
- `vite-plugin-tailwindcss` で直接統合可能

## localStorage互換性

既存のデータと互換性を維持するため、localStorageキーはそのまま使用:
- `lastUploadedVideoUrl`
- `editvid_subtitles_<filename>`
- `editvid_subtitle_settings`

## Verification

1. 開発サーバー起動 (`npm run dev`)
2. Tailwind CSS が正しく適用されているか確認
3. ビデオアップロード機能確認
4. テロップ追加/編集/削除機能確認
5. タイムライン表示確認
6. エクスポート機能確認
7. ビルドテスト (`npm run build`)

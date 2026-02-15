# ポートフォリオプロジェクト レスポンシブ対応リファクタリング計画

## コンテキスト

現在のポートフォリオプロジェクトはReact 19 + TanStack Router + Tailwind CSS v4を使用しているが、モバイル表示に重大な問題がある。特にDiffページの2カラムレイアウトやChatSettingsポップアップはモバイルで使用不可な状態。この計画はモバイルファーストのアプローチで全画面サイズでの表示を最適化することを目的とする。

## 技術スタック

- React 19
- TanStack Router
- Tailwind CSS v4
- Hono（バックエンド）
- Vite

## Phase 1: 緊急対応（モバイルで使用不可）

### 1. Diffページの2カラムレイアウト修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/pages/diff/index.tsx`

**変更内容:**
- 行140: `h-screen` → `min-h-screen`
- 行173: `grid grid-cols-2` → `grid grid-cols-1 md:grid-cols-2`
- 行205: `splitView={true}` → 画面サイズに応じた動的制御

**実装詳細:**
```tsx
// 画面サイズ検出用フックを追加
const [isMobile, setIsMobile] = useState(false);

useEffect(() => {
  const checkMobile = () => setIsMobile(window.innerWidth < 768);
  checkMobile();
  window.addEventListener('resize', checkMobile);
  return () => window.removeEventListener('resize', checkMobile);
}, []);

// splitViewを動的に
<ReactDiffViewer splitView={!isMobile} ... />
```

### 2. ChatSettingsポップアップの固定幅修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-settings.tsx`

**変更内容:**
- 行208: `w-[420px]` → `w-auto md:w-[420px] max-w-[calc(100vw-2rem)]`
- 行208: 位置指定を `left-4 md:left-25` / `left-4 md:left-15` に変更
- 固定幅ラベルをフレキシブルに:
  - 行212: `w-[83px]` → `min-w-[60px] md:min-w-[83px]`
  - 行221: `w-[243px]` → `w-full md:w-[243px]`
  - 行255, 269, 284, 299, 320: `w-[110px]` → `min-w-[80px] md:min-w-[110px]`

### 3. ChatLayoutの会話履歴サイドバー修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-layout.tsx`

**変更内容:**
- Propsに `isSidebarOpen` と `onToggleSidebar` を追加
- モバイル: オーバーレイドロワー（`fixed inset-y-0 left-0 z-50 w-64`）
- デスクトップ: 常時表示（`md:relative md:translate-x-0 md:w-40`）
- オーバーレイ背景を追加

**実装詳細:**
```tsx
interface Props {
  conversations?: ReactNode
  isSidebarOpen?: boolean
  onToggleSidebar?: () => void
}

// サイドバー
<div className={`
  fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-gray-800
  transform transition-transform duration-300 ease-in-out
  md:relative md:translate-x-0 md:w-40 md:z-auto
  ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
`}>
  {conversations}
</div>

// オーバーレイ背景
{isSidebarOpen && (
  <div
    className="fixed inset-0 bg-black/50 z-40 md:hidden"
    onClick={onToggleSidebar}
  />
)}
```

**親コンポーネント（chat/index.tsx）での使用:**
```tsx
const [isSidebarOpen, setIsSidebarOpen] = useState(false);

<ChatLayout
  isSidebarOpen={isSidebarOpen}
  onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
  conversations={...}
>
```

### 4. AppLayoutのサイドバー修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/app-layout.tsx`

**変更内容:**
- Propsに `isMobileMenuOpen` と `onToggleMobileMenu` を追加
- デスクトップ: 左サイドバー（`hidden md:flex`）
- モバイル: トップヘッダー + ドロワーメニュー
- メインコンテンツに `pt-14 md:pt-0` を追加

**実装詳細:**
```tsx
interface Props {
  version: string
  menuItems: MenuItem[]
  children: ReactNode
  isMobileMenuOpen?: boolean
  onToggleMobileMenu?: () => void
}

// デスクトップサイドバー
<div className='hidden md:flex h-screen w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4 dark:border-gray-700 dark:bg-gray-800'>
  {/* 既存ナビゲーション */}
</div>

// モバイルトップヘッダー
<div className='md:hidden fixed top-0 left-0 right-0 h-14 bg-gray-100 dark:bg-gray-800 border-b dark:border-gray-700 z-50 flex items-center justify-between px-4'>
  <button onClick={onToggleMobileMenu}>
    {/* ハンバーガーアイコン */}
  </button>
  <span>Portfolio</span>
  <ThemeToggle size='sm' />
</div>

// モバイルドロワーメニュー
{isMobileMenuOpen && (
  <>
    <div className='md:hidden fixed inset-0 bg-black/50 z-50' onClick={onToggleMobileMenu} />
    <div className='md:hidden fixed top-14 left-0 right-0 bg-gray-100 dark:bg-gray-800 border-b dark:border-gray-700 z-50 p-4'>
      <nav className='grid grid-cols-4 gap-2'>
        {/* メニュー項目 */}
      </nav>
    </div>
  </>
)}

// メインコンテンツ
<main className='flex-1 overflow-y-hidden bg-white md:overflow-y-auto dark:bg-gray-900 pt-14 md:pt-0'>
  {children}
</main>
```

## Phase 2: 中優先度

### 5. PromptTemplateの非表示修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/chat/prompt-template.tsx`

**変更内容:**
- 行118: `hidden sm:block` を削除
- 行119: `sm:grid-cols-2` → `md:grid-cols-2`

### 6. ChatSettingsの固定幅ラベル修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-settings.tsx`

既にPhase 1で実施済み。

### 7. 画像アップロードボタンのテキスト修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-main.tsx`

**変更内容:**
- 行494: テキスト部分に `hidden sm:block` を追加
- 行742（2つ目のボタン）も同様に修正

**実装詳細:**
```tsx
<button ...>
  <UploadIcon size={20} ... />
  <div className='hidden sm:block mr-0.5 text-gray-500 text-xs ...'>
    画像アップロード
  </div>
</button>
```

## Phase 3: 低優先度

### 8. h-screen → min-h-screen変更
**ファイル:**
- `/workspaces/monorepo/projects/portfolio/src/client/pages/diff/index.tsx`（行140）
- `/workspaces/monorepo/projects/portfolio/src/client/pages/about/index.tsx`（行48）
- `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-layout.tsx`（行10）

### 9. Aboutページのproseクラス修正
**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/pages/about/index.tsx`

**変更内容:**
- 行49: `prose` → `prose-sm md:prose`

## 新規コンポーネント

### MobileDrawer（オプション）
再利用可能なドロワーコンポーネント。

**ファイル:** `/workspaces/monorepo/projects/portfolio/src/client/components/mobile-drawer.tsx`

```tsx
interface MobileDrawerProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  position?: 'left' | 'right' | 'bottom'
  width?: string
}
```

## テスト計画

### ブレークポイント
- sm: 640px
- md: 768px
- lg: 1024px

### テスト項目
1. iPhone SE (375px) での表示確認
2. iPhone 14 (390px) での表示確認
3. iPad Mini (768px) での表示確認
4. デスクトップ (1024px+) での表示確認
5. ダークモード切り替え時の表示確認
6. 画面回転時のレイアウト確認

## 重要ファイル一覧

| ファイルパス | 変更内容 |
|-------------|---------|
| `/workspaces/monorepo/projects/portfolio/src/client/components/app-layout.tsx` | モバイル対応ナビゲーション |
| `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-layout.tsx` | ドロワー形式サイドバー |
| `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-settings.tsx` | ポップアップレスポンシブ対応 |
| `/workspaces/monorepo/projects/portfolio/src/client/pages/diff/index.tsx` | 2カラムグリッド修正 |
| `/workspaces/monorepo/projects/portfolio/src/client/components/chat/chat-main.tsx` | ボタンレスポンシブ対応 |
| `/workspaces/monorepo/projects/portfolio/src/client/components/chat/prompt-template.tsx` | テンプレート表示修正 |
| `/workspaces/monorepo/projects/portfolio/src/client/pages/about/index.tsx` | proseクラス修正 |

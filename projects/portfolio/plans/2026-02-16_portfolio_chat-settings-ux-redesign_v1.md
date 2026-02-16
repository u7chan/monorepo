---
created: 2026-02-16
project: portfolio
version: v1
previous_version: null
status: ready
---

# Chat Settings UX Redesign Plan

## Context

チャット設定画面のUXを改善し、より使いやすいUIに変更する。

- 現在: ポップアップメニュー形式で設定項目を表示
- 目標: 右側からスライドインするパネル形式に変更し、モデル選択の挙動も改善

## Requirements

### 1. UIレイアウト変更

- ポップアップ形式 → 右側からスライドインするパネル（前面表示）
- オーバーレイ背景を表示し、クリックで閉じられる
- アニメーション: `transform transition-transform duration-300 ease-in-out`

### 3. レスポンシブ対応

| 画面サイズ                   | パネル幅        | 説明                                     |
| ---------------------------- | --------------- | ---------------------------------------- |
| モバイル（< 640px）          | `w-full` (100%) | 全画面表示、ヘッダーに閉じるボタンを配置 |
| タブレット（640px - 1024px） | `w-[400px]`     | 右側からスライドイン                     |
| デスクトップ（> 1024px）     | `w-[450px]`     | 右側からスライドイン、より広めの表示     |

- モバイル表示時は画面下部に安全マージン（safe-area-inset-bottom）を考慮
- パネル内コンテンツは縦スクロール可能にする（`overflow-y-auto`）

### 2. モデル選択の挙動変更

| 自動取得トグル | 設定画面での表示                | メイン画面での表示     |
| -------------- | ------------------------------- | ---------------------- |
| ON             | プルダウン（select）で選択      | プルダウンで選択       |
| OFF            | テキスト入力（input）で自由入力 | ラベル表示（変更不可） |

## Implementation Details

### Component Structure

コンポーネントを適切に分割し、責務を明確にする：

```
chat-settings/
├── chat-settings.tsx          # メインコンテナ（パネルの開閉・オーバーレイ管理）
├── chat-settings-panel.tsx    # スライドインパネル本体（レイアウト・ヘッダー）
├── chat-settings-form.tsx     # 設定フォーム（各設定項目の構成）
├── model-selector.tsx         # モデル選択（select/inputの条件分岐）
└── settings/                  # 個別設定項目
    ├── auto-model-toggle.tsx  # 自動取得トグル
    ├── reasoning-effort.tsx   # 推論努力度
    └── ...
```

### Files to Modify

- `src/client/components/chat/chat-settings.tsx` - メインの設定コンポーネント（分割後はコンテナとして簡略化）

### Key Changes

#### 1. パネルレイアウト変更

```tsx
// オーバーレイ背景（クリックで閉じる）
{
  showPopup && <div className='fixed inset-0 bg-black/50 z-40 transition-opacity duration-300' onClick={onHidePopup} />
}

// 右側スライドインパネル（レスポンシブ対応）
;<div
  className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] lg:w-[450px] bg-white dark:bg-gray-800 shadow-xl transform transition-transform duration-300 ease-in-out ${showPopup ? 'translate-x-0' : 'translate-x-full'}`}
>
  {/* ヘッダー（モバイル用閉じるボタン） */}
  <div className='flex items-center justify-between p-4 border-b'>
    <h2>Chat Settings</h2>
    <button onClick={onHidePopup} className='sm:hidden'>
      ✕
    </button>
  </div>
  {/* 設定内容（スクロール可能） */}
  <div className='overflow-y-auto h-full pb-safe'>{/* 設定項目 */}</div>
</div>
```

#### 2. モデル選択UIの条件分岐

```tsx
// autoModelがONの場合: プルダウン
<select ...>
  {fetchedModels.map(model => <option ... />)}
</select>

// autoModelがOFFの場合: テキスト入力
<input type="text" ... />
```

#### 3. メイン画面でのモデル表示

- `autoModel`がONの場合: プルダウンで選択可能
- `autoModel`がOFFの場合: ラベル表示のみ（編集不可）

## Verification Steps

1. 設定ボタン（歯車アイコン）をクリック
2. 右側からパネルがスライドインすることを確認
3. オーバーレイ背景が表示され、クリックで閉じることを確認
4. 「自動取得」トグルのON/OFFでモデル選択UIが切り替わることを確認
   - ON: プルダウン表示
   - OFF: テキスト入力表示
5. メイン画面でのモデル表示:
   - ON: プルダウンでモデル選択可能
   - OFF: ラベル表示のみ（編集不可）
6. ダークモードで表示が正しく反映されることを確認
7. レスポンシブ対応の確認:
   - モバイル画面（375pxなど）で全画面表示になることを確認
   - モバイル時にヘッダーに閉じるボタンが表示されることを確認
   - タブレット/デスクトップで適切な幅（400px/450px）で表示されることを確認
   - 画面回転時も正しく表示されることを確認

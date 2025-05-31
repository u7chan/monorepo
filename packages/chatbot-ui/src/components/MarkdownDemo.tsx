import type React from 'react'
import MarkdownRenderer from './MarkdownRenderer'

const sampleMarkdown = `# Markdownレンダリングデモ

このコンポーネントは**Markdown**を美しくレンダリングします。

## 機能

- シンタックスハイライト付きコードブロック
- *イタリック*と**太字**のテキスト
- リストとテーブル
- 引用ブロック

### コードブロックの例

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
  return \`Welcome to our app, \${name}!\`;
}

const user = "世界";
greet(user);
\`\`\`

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

# フィボナッチ数列の計算
for i in range(10):
    print(f"F({i}) = {fibonacci(i)}")
\`\`\`

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
}

const createUser = (userData: Omit<User, 'id'>): User => {
  return {
    id: Math.random(),
    ...userData
  };
};
\`\`\`

### インラインコード

\`const variable = "value"\`のようなインラインコードもサポートしています。

## リスト

### 順序なしリスト
- アイテム1
- アイテム2
  - サブアイテム
  - もう一つのサブアイテム
- アイテム3

### 順序ありリスト
1. 最初のステップ
2. 二番目のステップ
3. 最後のステップ

## 引用

> これは引用ブロックです。
> 複数行にわたって書くことができます。

## テーブル

| 名前 | 年齢 | 職業 |
|------|------|------|
| 田中 | 25 | エンジニア |
| 佐藤 | 30 | デザイナー |
| 鈴木 | 28 | プロダクトマネージャー |

## リンク

[React公式サイト](https://react.dev)をチェックしてください。

---

このコンポーネントは\`ダークモード\`にも対応しています！
`

const MarkdownDemo: React.FC = () => {
  return (
    <div className='container mx-auto max-w-4xl p-6'>
      <div className='mb-8'>
        <h1 className='mb-4 font-bold text-3xl text-gray-900 dark:text-gray-100'>
          Markdownレンダリングコンポーネント デモ
        </h1>
        <p className='text-gray-600 dark:text-gray-400'>
          以下は、MarkdownRendererコンポーネントの動作例です。
        </p>
      </div>

      <div className='rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800'>
        <MarkdownRenderer content={sampleMarkdown} />
      </div>
    </div>
  )
}

export default MarkdownDemo

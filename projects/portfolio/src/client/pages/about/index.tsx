import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const source = `
# 私たちについて

Portfolio へようこそ！

## ミッション

私たちのミッションは、\`日常生活を豊かにする高品質な製品を提供する\`です。

革新と献身を通じて、私たちはお客様とコミュニティのためにより良い未来を創造できると信じています。

## 価値観

- **誠実さ**: すべての行動において最高の誠実さを保持します。
- **顧客へのコミットメント**: お客様の生活にポジティブな影響を与える関係を築きます。
- **品質**: 卓越した製品と比類のないサービスを提供し、お客様にプレミアム価値を届けます。

## チーム

私たちのチームは、それぞれの分野での専門家で構成されており、情熱を持って取り組んでいます。

お客様の多様なニーズを満たし、目標達成を支援するために協力して作業しています。

## お問い合わせ

ぜひご意見やご質問をお聞かせください！以下の連絡先までお気軽にご連絡ください：

- **メール**: [info@yourcompany.com](mailto:info@yourcompany.com)
- **電話**: [+1 (123) 456-7890](tel:+11234567890)
- **住所**: 160-0022 東京都新宿区霞ヶ丘町1-23-45 サンプルビル301号室

私たちのページにお越しいただき、ありがとうございます。

サービスを提供できることを楽しみにしています！

---

*最終更新日: ${new Date().toLocaleDateString()}*

🤖これは生成AIによるダミー文章です。
`

export function About() {
  return (
    <div className='min-h-full bg-white px-4 py-6 dark:bg-gray-900 md:px-8 md:py-8'>
      <div className='mx-auto max-w-3xl'>
        <div className='prose prose-sm max-w-none text-gray-700 prose-headings:text-gray-900 prose-strong:text-gray-900 prose-a:text-blue-700 prose-code:text-gray-800 prose-pre:bg-gray-950 md:prose-base dark:prose-invert dark:text-gray-200 dark:prose-headings:text-white dark:prose-strong:text-white dark:prose-a:text-blue-300 dark:prose-code:text-gray-100'>
          <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
        </div>
      </div>
    </div>
  )
}

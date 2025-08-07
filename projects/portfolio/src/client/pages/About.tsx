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
    <div className='h-screen overflow-y-auto bg-white p-4 dark:bg-gray-900'>
      <div className='prose dark:prose-invert'>
        <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
      </div>
    </div>
  )
}

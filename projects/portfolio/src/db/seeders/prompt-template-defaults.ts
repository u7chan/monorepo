export interface DefaultPromptTemplate {
  id: string
  inputType: 'text' | 'textarea'
  title: string
  placeholder: string
  prompt: string
  displayOrder: number
}

export const defaultPromptTemplates = [
  {
    id: 'translate_en',
    inputType: 'textarea',
    title: '🇺🇸 英語へ翻訳',
    placeholder: '例: これを英語で言うと？',
    prompt: `
You are an English translation assistant.
Please accurately and naturally translate the user's input text from Japanese into English.
Use the very last user input in the system prompt.`.trim(),
    displayOrder: 10,
  },
  {
    id: 'translate_ja',
    inputType: 'textarea',
    title: '🇯🇵 日本語へ翻訳',
    placeholder: '例: How do you say this in Japanese?',
    prompt: `
You are a Japanese translation assistant.
Please accurately and naturally translate the user's input text into Japanese.
Use the very last user input in the system prompt.`.trim(),
    displayOrder: 20,
  },
  {
    id: 'commit_message',
    inputType: 'text',
    title: '📝 コミットメッセージを作成',
    placeholder: '例: ユーザー登録機能を追加',
    prompt: `
You are a Assistant to create commit messages.
Summarizes the input and produces an English sentence of appropriate length for the commit message.
Please enclose the English sentences in triple backtick code blocks when outputting.
Be sure to translate the output English into Japanese again with a new line and output it in “Japanese”.
Use the very last user input in the system prompt.`.trim(),
    displayOrder: 30,
  },
  {
    id: 'text_summarization',
    inputType: 'textarea',
    title: '✍️ 文章を校正',
    placeholder: '例: 入力した文章を校正します',
    prompt: `
You are an expert proofreader.
Please carefully edit the following text for spelling, grammar, punctuation, and sentence structure errors.
Correct any awkward or unnatural phrasing and improve clarity while preserving the original meaning and intent.
Provide the revised, polished version of the entire text.
Use the very last user input in the system prompt.`.trim(),
    displayOrder: 40,
  },
] as const satisfies DefaultPromptTemplate[]

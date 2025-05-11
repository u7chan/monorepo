import OpenAI from 'openai'

export async function translateToEnglish(content: string): Promise<string> {
	// Call OpenAI API to translate the text
	const openai = new OpenAI()
	const response = await openai.chat.completions.create({
		model: 'gpt-4.1-nano',
		messages: [
			{
				role: 'system',
				content:
					'You are a professional translator. Translate the following Japanese text to English while preserving the original meaning and nuance.',
			},
			{
				role: 'user',
				content,
			},
		],
	})
	return response.choices[0].message.content || ''
}

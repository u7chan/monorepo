import OpenAI from "openai";

const openai = new OpenAI();

export async function translateToEnglish(content: string): Promise<string> {
	// Call OpenAI API to translate the text
	const response = await openai.chat.completions.create({
		model: "gpt-4.1-nano",
		messages: [
			{
				role: "system",
				content:
					"You are a professional translator. Translate the following Japanese text to English while preserving the original meaning and nuance.",
			},
			{
				role: "user",
				content,
			},
		],
	});
	return response.choices[0].message.content || "";
}

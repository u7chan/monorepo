import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: {
  baseUrl: "https://generativelanguage.googleapis.com"
} });

async function main() {
  const response = await ai.models.generateContentStream({
    model: "gemini-2.0-flash",
    contents: "なぜ空は青いの?",
  });
  for await (const chunk of response) {
    console.log(chunk.text);
  }
}

main();

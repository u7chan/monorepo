// 手書きの合成fixture。実API応答や再生可能な生成音声の写しではない。
export const SYNTHETIC_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
export const bgmEvent = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
export const bgmAudio = (data = SYNTHETIC_MP3.toString("base64"), id = "synthetic-track") => ({
  choices: [{ index: 0, delta: { audio: { id, data, transcript: "not audio" } }, finish_reason: null }],
});
export const bgmStop = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
export const SYNTHETIC_BGM_SSE =
  ": keep-alive\n\n" +
  bgmEvent({ choices: [{ delta: { content: "not audio" } }] }) +
  bgmEvent(bgmAudio()) +
  bgmEvent(bgmStop) +
  bgmEvent({ ...bgmStop, usage: { completion_tokens: 1 } }) +
  "data: [DONE]\n\n";

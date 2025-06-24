import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import log4js, { levels } from "log4js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";

import { currentTime } from "./features/currentTime";
import { omikuji } from "./features/omikuji";
import { reverseString } from "./features/reverseString";
import { kotowaza } from "./features/kotowaza";

const logger = log4js.getLogger();
logger.level = levels.INFO;

const mcpServer = new McpServer({
	name: "hono-mcp-server",
	version: "1.0.1",
});

mcpServer.tool("current_time", "現在の時刻を取得します", {}, () => {
	logger.info("» [currentTime] input:", {});
	const output = currentTime();
	logger.info("« [currentTime] output:", output);
	return {
		content: [
			{
				type: "text",
				text: output,
			},
		],
	};
});

mcpServer.tool(
	"reverse_string",
	"入力文字列を反転します",
	{ text: z.string() },
	(input) => {
		logger.info("» [reverseString] input:", input.text);
		const output = reverseString(input.text);
		logger.info("« [reverseString] output:", output);
		return {
			content: [
				{
					type: "text",
					text: output,
				},
			],
		};
	},
);

mcpServer.tool("omikuji", "ランダムにおみくじ結果を返します", {}, () => {
	logger.info("» [omikuji] input:", {});
	const output = omikuji();
	logger.info("« [omikuji] output:", output);
	return {
		content: [
			{
				type: "text",
				text: output,
			},
		],
	};
});

mcpServer.tool("kotowaza", "ランダムにことわざを返します", {}, () => {
	logger.info("» [kotowaza] input:", {});
	const output = kotowaza();
	logger.info("« [kotowaza] output:", output);
	return {
		content: [
			{
				type: "text",
				text: output,
			},
		],
	};
});

const app = new Hono();
const customLogger = (message: string) => {
	logger.info(message);
};
app.use(honoLogger(customLogger));

app.all("/mcp", async (c) => {
	const transport = new StreamableHTTPTransport();
	await mcpServer.connect(transport);
	return transport.handleRequest(c);
});

export default app;

import { defineConfig } from "vite";
import devServer from "@hono/vite-dev-server";

export default defineConfig(() => {
	return {
		plugins: [
			devServer({
				entry: "./src/server.tsx",
			}),
		],
	};
});

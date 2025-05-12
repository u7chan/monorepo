export function omikuji(): string {
	const results = ['大吉', '吉', '中吉', '小吉', '末吉', '凶', '大凶']
	const randomIndex = Math.floor(Math.random() * results.length)
	return results[randomIndex]
}

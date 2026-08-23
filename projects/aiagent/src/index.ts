import { createApp } from "./app"
import { createHarness } from "./harness"

// モデルは AIAGENT_MODEL で固定する (未指定なら pi のデフォルトに従う)
const harness = await createHarness({ model: process.env.AIAGENT_MODEL })

export default createApp({ harness })

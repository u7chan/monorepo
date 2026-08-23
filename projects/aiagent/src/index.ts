import { createApp } from "./app"
import { createHarness } from "./harness"

const harness = await createHarness({ model: process.env.AIAGENT_MODEL })

export default createApp({ harness })

import { createApp } from "./app"
import { createHarness } from "./harness"

const harness = await createHarness()

export default createApp({ harness })

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type DeliveryMode = "queue" | "steer" | "interrupt";

export async function sendCorrection(
  session: AgentSession,
  activeRun: Promise<void>,
  text: string,
  mode: DeliveryMode,
): Promise<void> {
  if (mode === "steer") {
    await session.steer(text);
    return;
  }
  if (mode === "queue") {
    await activeRun;
  } else {
    session.clearQueue();
    await session.abort();
  }
  await session.prompt(text);
}

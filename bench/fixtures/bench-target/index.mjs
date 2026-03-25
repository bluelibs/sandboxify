import { setTimeout as delay } from "node:timers/promises";

export function rpcNoop() {
  return 1;
}

export function echoPayload(payload) {
  return payload;
}

export async function remoteWork200ms() {
  const startedAt = performance.now();
  await delay(200);
  return Math.round(performance.now() - startedAt);
}

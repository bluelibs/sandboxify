import { AsyncLocalStorage } from "node:async_hooks";
import { loadPolicySync } from "../policy/index.js";
import { RuntimePool } from "./pool.js";

let runtimePool = null;
let cleanupHooksRegistered = false;
const loadTraceStorage = new AsyncLocalStorage();

export async function getRemoteModule({
  bucket,
  specifier,
  realUrl,
  exportNames,
  loadTrace = null,
}) {
  const pool = getRuntimePool();
  return pool.getRemoteModule({
    bucket,
    specifier,
    realUrl,
    exportNames,
    loadTrace: normalizeLoadTrace(loadTrace ?? loadTraceStorage.getStore()),
  });
}

export function getRuntimePool() {
  if (runtimePool) {
    return runtimePool;
  }

  const policyPath =
    process.env.SANDBOXIFY_POLICY_PATH ?? "./sandboxify.policy.jsonc";
  const policy = loadPolicySync(policyPath);
  runtimePool = new RuntimePool(policy);
  registerCleanupHooks();
  return runtimePool;
}

export function resetRuntimePool() {
  if (runtimePool) {
    runtimePool.close();
  }
  runtimePool = null;
}

export function runWithLoadTrace(loadTrace, fn) {
  return loadTraceStorage.run(normalizeLoadTrace(loadTrace), fn);
}

function registerCleanupHooks() {
  if (cleanupHooksRegistered) {
    return;
  }

  cleanupHooksRegistered = true;

  const closePool = () => {
    if (runtimePool) {
      runtimePool.close();
      runtimePool = null;
    }
  };

  process.once("SIGINT", () => {
    closePool();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    closePool();
    process.exit(143);
  });
}

function normalizeLoadTrace(loadTrace) {
  if (!Array.isArray(loadTrace)) {
    return [];
  }

  return loadTrace.filter((entry) => typeof entry === "string" && entry.length > 0);
}

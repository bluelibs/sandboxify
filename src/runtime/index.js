import { loadPolicySync } from "../policy/index.js";
import { RuntimePool } from "./pool.js";

let runtimePool = null;
let cleanupHooksRegistered = false;

export async function getRemoteModule({
  bucket,
  specifier,
  realUrl,
  exportNames,
}) {
  const pool = getRuntimePool();
  return pool.getRemoteModule({ bucket, specifier, realUrl, exportNames });
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

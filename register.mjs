import { registerHooks } from "node:module";
import { createSandboxHooks } from "./src/loader/index.js";

const policyPath =
  process.env.SANDBOXIFY_POLICY_PATH ?? "./sandboxify.policy.jsonc";
const manifestPath =
  process.env.SANDBOXIFY_MANIFEST_PATH ?? "./.sandboxify/exports.manifest.json";

registerHooks(createSandboxHooks({ policyPath, manifestPath }));

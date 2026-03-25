import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function runNode({ cwd, args, env = {}, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function buildManifest(projectDir) {
  const cliPath = path.join(repoRoot, "src", "cli", "index.js");
  return runNode({ cwd: projectDir, args: [cliPath, "build-manifest"] });
}

export async function runWithLoader(projectDir, appFile, extraEnv = {}) {
  const registerPath = path.join(repoRoot, "register.mjs");
  return runNode({
    cwd: projectDir,
    args: ["--import", registerPath, appFile],
    env: {
      SANDBOXIFY_POLICY_PATH: path.join(projectDir, "sandboxify.policy.jsonc"),
      SANDBOXIFY_MANIFEST_PATH: path.join(
        projectDir,
        ".sandboxify",
        "exports.manifest.json",
      ),
      ...extraEnv,
    },
  });
}

export async function runWithCjsRegister(projectDir, appFile, extraEnv = {}) {
  const registerCjsPath = path.join(repoRoot, "register-cjs.cjs");
  return runNode({
    cwd: projectDir,
    args: ["-r", registerCjsPath, appFile],
    env: {
      SANDBOXIFY_POLICY_PATH: path.join(projectDir, "sandboxify.policy.jsonc"),
      SANDBOXIFY_MANIFEST_PATH: path.join(
        projectDir,
        ".sandboxify",
        "exports.manifest.json",
      ),
      ...extraEnv,
    },
  });
}

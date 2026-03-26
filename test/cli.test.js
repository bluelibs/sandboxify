import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runNode } from "./helpers/command.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src", "cli", "index.js");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createTmpDir(prefix = "sandboxify-cli-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(cwd, args = [], env = {}) {
  return runNode({
    cwd,
    args: [cliPath, ...args],
    env,
  });
}

test("cli prints usage for no command and exits 1 for unknown commands", async () => {
  const tmpDir = createTmpDir();

  try {
    const noCommand = await runCli(tmpDir);
    assert.equal(noCommand.code, 0);
    assert.match(noCommand.stdout, /sandboxify <command> \[options]/);

    const unknown = await runCli(tmpDir, ["wat"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout, /Commands:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cli doctor reports ok for a valid policy and manifest", async () => {
  const tmpDir = createTmpDir();

  try {
    writeFile(
      path.join(tmpDir, "sandboxify.policy.jsonc"),
      JSON.stringify(
        {
          buckets: {
            cpu_only: {
              allowNet: false,
              allowFsRead: ["./node_modules"],
              allowFsWrite: [],
              allowChildProcess: false,
              allowWorker: false,
              allowAddons: false,
            },
          },
          packages: {
            "fixture-lib": "cpu_only",
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(tmpDir, ".sandboxify", "exports.manifest.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          nodeVersion: process.version,
          entriesByUrl: {},
          entriesBySpecifier: {},
        },
        null,
        2,
      ),
    );

    const result = await runCli(tmpDir, ["doctor"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /doctor report/);
    assert.match(result.stdout, /manifest: \.\/\.sandboxify\/exports\.manifest\.json \(present\)/);
    assert.match(result.stdout, /status: ok/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cli doctor reports issues for missing policies and invalid manifests", async () => {
  const tmpDir = createTmpDir();

  try {
    writeFile(
      path.join(tmpDir, "broken-manifest.json"),
      "{ definitely not json",
    );

    const result = await runCli(tmpDir, [
      "doctor",
      "--policy",
      "./missing-policy.jsonc",
      "--manifest",
      "./broken-manifest.json",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /doctor report/);
    assert.match(result.stderr, /Policy could not be loaded:/);
    assert.match(result.stderr, /Manifest is invalid:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cli doctor warns when running on Node versions below 25", async () => {
  const tmpDir = createTmpDir();

  try {
    writeFile(
      path.join(tmpDir, "sandboxify.policy.jsonc"),
      JSON.stringify(
        {
          buckets: {
            cpu_only: {
              allowNet: false,
              allowFsRead: ["./node_modules"],
              allowFsWrite: [],
              allowChildProcess: false,
              allowWorker: false,
              allowAddons: false,
            },
          },
          packages: {},
        },
        null,
        2,
      ),
    );

    const wrapperPath = path.join(tmpDir, "doctor-node24.mjs");
    writeFile(
      wrapperPath,
      `
        Object.defineProperty(process, "versions", {
          value: { ...process.versions, node: "24.9.0" },
        });
        process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "doctor"];
        await import(${JSON.stringify(pathToFileURL(cliPath).href)});
      `,
    );

    const result = await runNode({
      cwd: tmpDir,
      args: [wrapperPath],
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /warning: Node < 25 detected/);
    assert.match(result.stdout, /status: ok/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cli build-manifest succeeds with custom paths and surfaces failures", async () => {
  const tmpDir = createTmpDir();

  try {
    writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        { name: "cli-fixture", private: true, type: "module" },
        null,
        2,
      ),
    );
    writeFile(
      path.join(tmpDir, "node_modules", "fixture-lib", "package.json"),
      JSON.stringify(
        {
          name: "fixture-lib",
          version: "1.0.0",
          type: "module",
          exports: "./index.mjs",
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(tmpDir, "node_modules", "fixture-lib", "index.mjs"),
      "export const named = 42;\n",
    );
    writeFile(
      path.join(tmpDir, "config", "policy.jsonc"),
      JSON.stringify(
        {
          buckets: {
            cpu_only: {
              allowNet: false,
              allowFsRead: ["./node_modules"],
              allowFsWrite: [],
              allowChildProcess: false,
              allowWorker: false,
              allowAddons: false,
            },
          },
          packages: {
            "fixture-lib": "cpu_only",
          },
        },
        null,
        2,
      ),
    );

    const success = await runCli(tmpDir, [
      "build-manifest",
      "--policy",
      "./config/policy.jsonc",
      "--manifest",
      "./custom/manifest.json",
    ]);
    assert.equal(success.code, 0);
    assert.match(success.stdout, /manifest written: \.\/custom\/manifest\.json/);
    assert.match(success.stdout, /entries: 1/);
    assert.ok(fs.existsSync(path.join(tmpDir, "custom", "manifest.json")));

    const failure = await runCli(tmpDir, [
      "build-manifest",
      "--policy",
      "./missing-policy.jsonc",
    ]);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /build-manifest failed:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSandboxHooks } from "../src/loader/index.js";
import {
  buildManifest,
  getManifestEntry,
  readManifestSync,
} from "../src/manifest/index.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function createTmpDir(prefix = "sandboxify-loader-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withCwd(tmpDir, fn) {
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
  }
}

async function withCwdAsync(tmpDir, fn) {
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

test(
  "createSandboxHooks bypasses entirely when SANDBOXIFY_DISABLE=1",
  { concurrency: false },
  () => {
    const previous = process.env.SANDBOXIFY_DISABLE;
    process.env.SANDBOXIFY_DISABLE = "1";

    try {
      const hooks = createSandboxHooks();
      const resolved = hooks.resolve(
        "pkg",
        { parentURL: "file:///app/index.mjs" },
        () => ({ url: "file:///resolved.mjs" }),
      );
      const loaded = hooks.load(
        "file:///resolved.mjs",
        {},
        () => ({ format: "module", source: "export {};\n" }),
      );

      assert.equal(resolved.url, "file:///resolved.mjs");
      assert.equal(loaded.source, "export {};\n");
    } finally {
      if (previous == null) {
        delete process.env.SANDBOXIFY_DISABLE;
      } else {
        process.env.SANDBOXIFY_DISABLE = previous;
      }
    }
  },
);

test(
  "createSandboxHooks resolves matched modules, caches records, and generates stable stubs",
  { concurrency: false },
  () => {
    const tmpDir = createTmpDir();
    const previousDebug = process.env.SANDBOXIFY_DEBUG;

    try {
      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
        buckets: {
          cpu_only: {
            allowNet: false,
            allowFsRead: ["./"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "./dep.mjs": "cpu_only",
        },
      });

      const depPath = path.join(tmpDir, "dep.mjs");
      writeFile(depPath, "export default 1;\n");
      writeJson(path.join(tmpDir, "manifest.json"), {
        version: 1,
        entriesByUrl: {
          [pathToFileURL(depPath).href]: {
            specifier: "./dep.mjs",
            exportNames: ["named", "default", "named", "not-valid", 123],
          },
        },
        entriesBySpecifier: {
          "./dep.mjs": {
            realUrl: pathToFileURL(depPath).href,
            exportNames: ["named", "default", "named", "not-valid", 123],
          },
        },
      });

      process.env.SANDBOXIFY_DEBUG = "1";
      const debugLines = [];

      withCwd(tmpDir, () => {
        const hooks = createSandboxHooks({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./manifest.json",
        });

        const consoleError = console.error;
        console.error = (line) => {
          debugLines.push(String(line));
        };

        try {
          const passthrough = hooks.resolve(
            "./other.mjs",
            { parentURL: "file:///app/index.mjs" },
            () => ({ url: "file:///other.mjs" }),
          );
          assert.equal(passthrough.url, "file:///other.mjs");

          const first = hooks.resolve(
            "./dep.mjs",
            { parentURL: "file:///app/index.mjs" },
            () => ({ url: pathToFileURL(depPath).href }),
          );
          const second = hooks.resolve(
            "./dep.mjs",
            { parentURL: "file:///app/index.mjs" },
            () => ({ url: pathToFileURL(depPath).href }),
          );

          assert.equal(first.url, second.url);
          assert.match(first.url, /^sandboxify:/);

          const loaded = hooks.load(first.url, {}, () => {
            throw new Error("unexpected nextLoad");
          });
          assert.equal(loaded.format, "module");
          assert.match(loaded.source, /export default __sandboxifyModule\.default;/);
          assert.match(loaded.source, /export const named = __sandboxifyModule\["named"\];/);
          assert.doesNotMatch(loaded.source, /export const not-valid =/);

          const fallbackLoad = hooks.load("file:///plain.mjs", {}, () => ({
            format: "module",
            source: "export const plain = true;\n",
          }));
          assert.equal(fallbackLoad.source, "export const plain = true;\n");

          assert.throws(
            () => hooks.load("sandboxify:missing", {}, () => ({})),
            /Sandbox record not found/,
          );
        } finally {
          console.error = consoleError;
        }
      });

      assert.ok(debugLines.some((line) => line.includes("[sandboxify][loader] resolve")));
      assert.ok(debugLines.some((line) => line.includes("[sandboxify][loader] load")));
    } finally {
      if (previousDebug == null) {
        delete process.env.SANDBOXIFY_DEBUG;
      } else {
        process.env.SANDBOXIFY_DEBUG = previousDebug;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "createSandboxHooks falls back cleanly when the manifest is missing",
  { concurrency: false },
  () => {
    const tmpDir = createTmpDir();

    try {
      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
        buckets: {
          cpu_only: {
            allowNet: false,
            allowFsRead: ["./"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "./dep.mjs": "cpu_only",
        },
      });

      const depPath = path.join(tmpDir, "dep.mjs");
      writeFile(depPath, "export default 1;\n");

      withCwd(tmpDir, () => {
        const hooks = createSandboxHooks({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./missing-manifest.json",
        });

        const resolved = hooks.resolve(
          "./dep.mjs",
          { parentURL: "file:///app/index.mjs" },
          () => ({ url: pathToFileURL(depPath).href }),
        );
        const loaded = hooks.load(resolved.url, {}, () => {
          throw new Error("unexpected nextLoad");
        });

        assert.match(loaded.source, /export default __sandboxifyModule\.default;/);
        assert.doesNotMatch(loaded.source, /export const /);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "createSandboxHooks sandboxes local files by resolved URL when the raw specifier spelling differs",
  { concurrency: false },
  () => {
    const tmpDir = createTmpDir("sandboxify-loader-resolved-");

    try {
      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
        buckets: {
          cpu_only: {
            allowNet: false,
            allowFsRead: ["./src"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "./src/dep.mjs": "cpu_only",
        },
      });

      const depPath = path.join(tmpDir, "src", "dep.mjs");
      const depUrl = withCwd(tmpDir, () => pathToFileURL(path.resolve("./src/dep.mjs")).href);
      const parentUrl = withCwd(tmpDir, () =>
        pathToFileURL(path.resolve("./app/main.mjs")).href,
      );
      writeFile(depPath, "export const named = true;\n");
      writeJson(path.join(tmpDir, "manifest.json"), {
        version: 1,
        entriesByUrl: {
          [depUrl]: {
            specifier: "./src/dep.mjs",
            exportNames: ["named", "default"],
          },
        },
        entriesBySpecifier: {
          "./src/dep.mjs": {
            realUrl: depUrl,
            exportNames: ["named", "default"],
          },
        },
      });

      withCwd(tmpDir, () => {
        const hooks = createSandboxHooks({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./manifest.json",
        });

        const resolved = hooks.resolve(
          "../src/dep.mjs",
          { parentURL: parentUrl },
          () => ({ url: depUrl }),
        );

        assert.match(resolved.url, /^sandboxify:/);

        const loaded = hooks.load(resolved.url, {}, () => {
          throw new Error("unexpected nextLoad");
        });

        assert.match(loaded.source, /export const named = __sandboxifyModule\["named"\];/);
        assert.match(
          loaded.source,
          new RegExp(depUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "createSandboxHooks reuses manifest export metadata across buckets for the same module",
  { concurrency: false },
  () => {
    const tmpDir = createTmpDir("sandboxify-loader-cache-");

    try {
      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
        buckets: {
          open: {
            allowNet: false,
            allowFsRead: ["./"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
          restricted: {
            allowNet: false,
            allowFsRead: ["./"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "./dep.mjs": "open",
        },
        importerRules: [
          {
            importer: "file:///app/restricted/*",
            specifier: "./dep.mjs",
            bucket: "restricted",
          },
        ],
      });

      const depPath = path.join(tmpDir, "dep.mjs");
      writeFile(depPath, "export const named = true;\n");
      writeJson(path.join(tmpDir, "manifest.json"), {
        version: 1,
        entriesByUrl: {
          [pathToFileURL(depPath).href]: {
            specifier: "./dep.mjs",
            exportNames: ["named", "default"],
          },
        },
        entriesBySpecifier: {
          "./dep.mjs": {
            realUrl: pathToFileURL(depPath).href,
            exportNames: ["named", "default"],
          },
        },
      });

      withCwd(tmpDir, () => {
        const hooks = createSandboxHooks({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./manifest.json",
        });

        const openResolved = hooks.resolve(
          "./dep.mjs",
          { parentURL: "file:///app/open/main.mjs" },
          () => ({ url: pathToFileURL(depPath).href }),
        );
        const restrictedResolved = hooks.resolve(
          "./dep.mjs",
          { parentURL: "file:///app/restricted/main.mjs" },
          () => ({ url: pathToFileURL(depPath).href }),
        );

        assert.notEqual(openResolved.url, restrictedResolved.url);

        const openLoad = hooks.load(openResolved.url, {}, () => {
          throw new Error("unexpected nextLoad");
        });
        const restrictedLoad = hooks.load(restrictedResolved.url, {}, () => {
          throw new Error("unexpected nextLoad");
        });

        assert.match(openLoad.source, /export const named = __sandboxifyModule\["named"\];/);
        assert.match(restrictedLoad.source, /export const named = __sandboxifyModule\["named"\];/);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "buildManifest handles wildcard, scoped, unresolved, broken, and CommonJS packages",
  { concurrency: false },
  async () => {
    const tmpDir = createTmpDir("sandboxify-manifest-extra-");

    try {
      writeJson(path.join(tmpDir, "package.json"), {
        name: "manifest-extra-fixture",
        private: true,
        type: "module",
      });

      writeJson(path.join(tmpDir, "node_modules", "wild-alpha", "package.json"), {
        name: "wild-alpha",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      });
      writeFile(
        path.join(tmpDir, "node_modules", "wild-alpha", "index.mjs"),
        "export const alpha = true;\n",
      );

      writeJson(path.join(tmpDir, "node_modules", "@scope", "pkg", "package.json"), {
        name: "@scope/pkg",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      });
      writeFile(
        path.join(tmpDir, "node_modules", "@scope", "pkg", "index.mjs"),
        "export default function scoped() { return 'ok'; }\n",
      );

      writeJson(path.join(tmpDir, "node_modules", "cjs-lib", "package.json"), {
        name: "cjs-lib",
        version: "1.0.0",
        main: "./index.cjs",
      });
      writeFile(
        path.join(tmpDir, "node_modules", "cjs-lib", "index.cjs"),
        "module.exports = function cjs() { return 'ok'; };\n",
      );

      writeJson(path.join(tmpDir, "node_modules", "broken-lib", "package.json"), {
        name: "broken-lib",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      });
      writeFile(
        path.join(tmpDir, "node_modules", "broken-lib", "index.mjs"),
        "throw new Error('broken on import');\n",
      );

      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
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
          "wild*": "cpu_only",
          "@scope/pkg": "cpu_only",
          "cjs-lib": "cpu_only",
          "broken-lib": "cpu_only",
          "missing-lib": "cpu_only",
        },
      });

      const manifest = await withCwdAsync(tmpDir, () =>
        buildManifest({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./.sandboxify/exports.manifest.json",
        }),
      );

      assert.ok(manifest.entriesBySpecifier["wild-alpha"]);
      assert.ok(manifest.entriesBySpecifier["@scope/pkg"]);
      assert.ok(manifest.entriesBySpecifier["cjs-lib"]);
      assert.equal(manifest.entriesBySpecifier["broken-lib"], undefined);
      assert.equal(manifest.entriesBySpecifier["missing-lib"], undefined);
      assert.ok(
        manifest.entriesBySpecifier["cjs-lib"].exportNames.includes("default"),
      );

      const loaded = withCwd(tmpDir, () =>
        readManifestSync("./.sandboxify/exports.manifest.json"),
      );
      assert.deepEqual(
        getManifestEntry(
          loaded,
          "file:///missing-url.mjs",
          "@scope/pkg",
        ),
        loaded.entriesBySpecifier["@scope/pkg"],
      );
      assert.equal(
        getManifestEntry(loaded, "file:///missing-url.mjs", "missing-lib"),
        null,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "buildManifest works without a root package.json and with missing node_modules",
  { concurrency: false },
  async () => {
    const tmpDir = createTmpDir("sandboxify-manifest-fallback-");
    const emptyDir = createTmpDir("sandboxify-manifest-empty-");

    try {
      writeJson(path.join(tmpDir, "node_modules", "fixture-lib", "package.json"), {
        name: "fixture-lib",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      });
      writeFile(
        path.join(tmpDir, "node_modules", "fixture-lib", "index.mjs"),
        "export const answer = 42;\n",
      );
      writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
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
      });

      const manifest = await withCwdAsync(tmpDir, () =>
        buildManifest({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./manifest.json",
        }),
      );
      assert.ok(manifest.entriesBySpecifier["fixture-lib"]);

      writeJson(path.join(emptyDir, "sandboxify.policy.jsonc"), {
        buckets: {
          cpu_only: {},
        },
        packages: {
          "wild*": "cpu_only",
        },
      });

      const emptyManifest = await withCwdAsync(emptyDir, () =>
        buildManifest({
          policyPath: "./sandboxify.policy.jsonc",
          manifestPath: "./manifest.json",
        }),
      );
      assert.deepEqual(emptyManifest.entriesBySpecifier, {});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  },
);

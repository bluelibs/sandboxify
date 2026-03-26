import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempProjectFromFixture,
  materializePolicy,
} from "./helpers/fixture-project.js";
import {
  buildManifest,
  runNode,
  runWithCjsRegister,
  runWithLoader,
} from "./helpers/command.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registerPath = path.join(repoRoot, "register.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function createTmpDir(prefix = "sandboxify-it-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createCustomProject({ policy, files, prefix }) {
  const projectDir = createTmpDir(prefix);

  writeJson(path.join(projectDir, "package.json"), {
    name: "sandboxify-it-custom",
    private: true,
    type: "module",
  });
  writeJson(path.join(projectDir, "sandboxify.policy.jsonc"), policy);

  for (const [relativePath, content] of Object.entries(files)) {
    writeFile(path.join(projectDir, relativePath), content);
  }

  return {
    projectDir,
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function createPackageFiles(packageName, indexSource) {
  return {
    [`node_modules/${packageName}/package.json`]: JSON.stringify(
      {
        name: packageName,
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      },
      null,
      2,
    ),
    [`node_modules/${packageName}/index.mjs`]: indexSource,
  };
}

function withTcpServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end("ok");
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

function stripAnsi(input) {
  return String(input).replace(/\u001b\[[0-9;]*m/g, "");
}

test(
  "integration: sandboxed function call succeeds",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "success.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /RESULT\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: child_process denied when not allowed",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "child-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CHILD_ERR\s+/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: network denied when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "net-check.mjs", {
        TEST_PORT: String(tcp.port),
      });
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /NET_ERR\s+/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: network allowed when allowNet=true",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: true });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "net-check.mjs", {
        TEST_PORT: String(tcp.port),
      });
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /NET_OK\s+connected/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: large binary args can use IPC blob offload",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "buffer-check.mjs",
        {
          SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BUFFER_SIZE\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: sandboxed function supports batch calls",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "batch-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BATCH_RESULT\s+3,7,11/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: sandboxed class exports support construction and instance methods",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "class-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CLASS_VALUE\s+2/);
      assert.match(stripAnsi(result.stdout), /CLASS_INC\s+5/);
      assert.match(stripAnsi(result.stdout), /CLASS_VALUE_AFTER\s+5/);
      assert.match(stripAnsi(result.stdout), /CLASS_DESC\s+value:5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: large binary batch args can use IPC blob offload",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "batch-buffer-check.mjs",
        {
          SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BATCH_BUFFER_RESULT\s+1,5,7/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: local file dependency can be sandboxed and used",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "file-dependency-check.mjs",
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /FILE_DEP_RESULT\s+12/);
      assert.match(stripAnsi(result.stdout), /FILE_DEP_CHILD_ERR\s+/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: default register paths work without SANDBOXIFY_* env overrides",
  { concurrency: false },
  async () => {
    const fixture = createCustomProject({
      prefix: "sandboxify-default-register-",
      policy: {
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
          "./src/local-lib.mjs": "cpu_only",
        },
      },
      files: {
        "src/local-lib.mjs": `
          export function add(a, b) {
            return a + b;
          }
        `,
        "entry.mjs": `
          import { add } from "./src/local-lib.mjs";
          console.log("DEFAULT_REGISTER_RESULT", await add(2, 3));
        `,
      },
    });

    try {
      const manifestResult = await runNode({
        cwd: fixture.projectDir,
        args: [path.join(repoRoot, "src", "cli", "index.js"), "build-manifest"],
      });
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runNode({
        cwd: fixture.projectDir,
        args: ["--import", registerPath, "entry.mjs"],
      });
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /DEFAULT_REGISTER_RESULT\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: same-bucket packages keep transitive imports native",
  { concurrency: false },
  async () => {
    const fixture = createCustomProject({
      prefix: "sandboxify-same-bucket-",
      policy: {
        buckets: {
          shared_bucket: {
            allowNet: false,
            allowFsRead: ["./node_modules"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "pkg-a": "shared_bucket",
          "pkg-b": "shared_bucket",
          "pkg-c": "shared_bucket",
        },
      },
      files: {
        ...createPackageFiles(
          "pkg-a",
          `
            import { plusOne, read as readB } from "pkg-b";
            import { plusTwo } from "pkg-c";

            export function chain(value) {
              return plusTwo(plusOne(value));
            }

            export function readViaA() {
              return readB();
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-b",
          `
            const sharedState = globalThis.__sandboxifySharedBucketState ??= { count: 0 };

            export function plusOne(value) {
              return value + 1;
            }

            export function bump(delta = 1) {
              sharedState.count += delta;
              return sharedState.count;
            }

            export function read() {
              return sharedState.count;
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-c",
          `
            export function plusTwo(value) {
              return value + 2;
            }
          `,
        ),
        "same-bucket-check.mjs": `
          import { chain, readViaA } from "pkg-a";
          import { bump } from "pkg-b";

          console.log("SAME_BUCKET_CHAIN", await chain(1));
          await bump(2);
          console.log("SAME_BUCKET_SHARED", await readViaA());
        `,
      },
    });

    try {
      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "same-bucket-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /SAME_BUCKET_CHAIN\s+4/);
      assert.match(stripAnsi(result.stdout), /SAME_BUCKET_SHARED\s+2/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: direct package orchestration supports object handles, property refs, returned handles, and simple callbacks",
  { concurrency: false },
  async () => {
    const fixture = createCustomProject({
      prefix: "sandboxify-object-handles-",
      policy: {
        buckets: {
          shared_bucket: {
            allowNet: false,
            allowFsRead: ["./src", "./node_modules"],
            allowFsWrite: [],
            allowChildProcess: false,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "pkg-object": "shared_bucket",
          "pkg-window": "shared_bucket",
          "pkg-format": "shared_bucket",
        },
      },
      files: {
        ...createPackageFiles(
          "pkg-object",
          `
            let prefix = "";
            let policy = () => true;

            const service = {
              addPrefix(value) {
                prefix += value;
              },
              setUrlAccessPolicy(nextPolicy) {
                policy = nextPolicy;
              },
              createBuilder(value) {
                return {
                  finish() {
                    if (!policy("allow")) {
                      throw new Error("blocked");
                    }

                    return prefix + value;
                  },
                };
              },
            };

            export default service;
          `,
        ),
        ...createPackageFiles(
          "pkg-window",
          `
            class WindowView {
              constructor(label) {
                this.label = label;
              }
            }

            export class WindowBox {
              constructor(label) {
                this._window = new WindowView(label);
              }

              get window() {
                return this._window;
              }
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-format",
          `
            export default function formatHtml(html, { window }) {
              return window.label + ":" + html;
            }
          `,
        ),
        "entry.mjs": `
          import service from "pkg-object";
          import { WindowBox } from "pkg-window";
          import formatHtml from "pkg-format";

          const { window } = new WindowBox("sandbox");

          service.addPrefix("pdf:");
          service.setUrlAccessPolicy((value) => value === "allow");

          const formatted = await formatHtml("hello", { window });
          const output = await service.createBuilder(formatted).finish();

          console.log("OBJECT_HANDLE_RESULT", output);
        `,
      },
    });

    try {
      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "entry.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /OBJECT_HANDLE_RESULT\s+pdf:sandbox:hello/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: cross-bucket imports bridge to the target bucket and keep same-bucket transitive imports native there",
  { concurrency: false },
  async () => {
    const fixture = createCustomProject({
      prefix: "sandboxify-cross-bucket-",
      policy: {
        buckets: {
          alpha: {
            allowNet: false,
            allowFsRead: ["./node_modules"],
            allowFsWrite: [],
            allowChildProcess: true,
            allowWorker: false,
            allowAddons: false,
            env: {
              SANDBOX_BUCKET_LABEL: "alpha",
            },
          },
          beta: {
            allowNet: false,
            allowFsRead: ["./node_modules"],
            allowFsWrite: [],
            allowChildProcess: true,
            allowWorker: false,
            allowAddons: false,
            env: {
              SANDBOX_BUCKET_LABEL: "beta",
            },
          },
        },
        packages: {
          "pkg-a": "alpha",
          "pkg-b": "beta",
          "pkg-c": "beta",
        },
      },
      files: {
        ...createPackageFiles(
          "pkg-a",
          `
            import { betaChain, readBucket } from "pkg-b";

            export async function alphaChain(value) {
              return (await betaChain(value)) + 100;
            }

            export function readBetaBucket() {
              return readBucket();
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-b",
          `
            import { addTwo, bucketLabel } from "pkg-c";

            export function betaChain(value) {
              return addTwo(value) + 10;
            }

            export function readBucket() {
              return bucketLabel();
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-c",
          `
            export function addTwo(value) {
              return value + 2;
            }

            export function bucketLabel() {
              return process.env.SANDBOX_BUCKET_LABEL;
            }
          `,
        ),
        "cross-bucket-check.mjs": `
          import { alphaChain, readBetaBucket } from "pkg-a";

          console.log("CROSS_BUCKET_CHAIN", await alphaChain(1));
          console.log("CROSS_BUCKET_LABEL", await readBetaBucket());
        `,
      },
    });

    try {
      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "cross-bucket-check.mjs",
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CROSS_BUCKET_CHAIN\s+113/);
      assert.match(stripAnsi(result.stdout), /CROSS_BUCKET_LABEL\s+beta/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: cross-bucket circular imports fail fast with a descriptive error",
  { concurrency: false },
  async () => {
    const fixture = createCustomProject({
      prefix: "sandboxify-cross-bucket-cycle-",
      policy: {
        buckets: {
          alpha: {
            allowNet: false,
            allowFsRead: ["./node_modules"],
            allowFsWrite: [],
            allowChildProcess: true,
            allowWorker: false,
            allowAddons: false,
          },
          beta: {
            allowNet: false,
            allowFsRead: ["./node_modules"],
            allowFsWrite: [],
            allowChildProcess: true,
            allowWorker: false,
            allowAddons: false,
          },
        },
        packages: {
          "pkg-a": "alpha",
          "pkg-b": "beta",
        },
      },
      files: {
        ...createPackageFiles(
          "pkg-a",
          `
            import { betaEcho } from "pkg-b";

            export function alphaEcho(value) {
              return betaEcho(value);
            }
          `,
        ),
        ...createPackageFiles(
          "pkg-b",
          `
            import { alphaEcho } from "pkg-a";

            export function betaEcho(value) {
              return alphaEcho(value);
            }
          `,
        ),
        "cross-bucket-cycle-check.mjs": `
          import { alphaEcho } from "pkg-a";

          console.log("CYCLE_RESULT", await alphaEcho("hello"));
        `,
      },
    });

    try {
      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "cross-bucket-cycle-check.mjs",
      );
      assert.notEqual(
        result.code,
        0,
        `app unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(
        stripAnsi(result.stderr),
        /Cross-bucket circular import detected: alpha -> beta -> alpha/,
      );
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS require flow supports successful call",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-success.cjs",
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_RESULT\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS require flow supports async class construction",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-class-check.cjs",
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_CLASS_VALUE\s+4/);
      assert.match(stripAnsi(result.stdout), /CJS_CLASS_INC\s+6/);
      assert.match(stripAnsi(result.stdout), /CJS_CLASS_VALUE_AFTER\s+6/);
      assert.match(stripAnsi(result.stdout), /CJS_CLASS_DESC\s+value:6/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS experimental sync mode supports sync call style",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-sync-experimental.cjs",
        {
          SANDBOXIFY_CJS_SYNC_EXPERIMENTAL: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_SYNC_RESULT\s+5/);
      assert.match(stripAnsi(result.stdout), /CJS_SYNC_BUFFER\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS require flow denies network when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-net-check.cjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_NET_ERR\s+/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: import-time network side effect is denied when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "sideeffect-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );

      assert.notEqual(
        result.code,
        0,
        "sideeffect import should fail when allowNet=false",
      );
      assert.match(
        stripAnsi(result.stderr),
        /ERR_ACCESS_DENIED|allow-net|permission/i,
      );
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: import-time network side effect succeeds when allowNet=true",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: true });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "sideeffect-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );

      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /SIDEEFFECT_READY\s+true/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

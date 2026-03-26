import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimePool } from "../src/runtime/pool.js";
import { RpcClient } from "../src/runtime/rpc-client.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function createTmpDir(prefix = "sandboxify-runtime-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setEnv(name, value) {
  const previous = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  return () => {
    if (previous == null) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

test(
  "RuntimePool proxies functions, batches, classes, values, and cleanup",
  { concurrency: false },
  async (t) => {
    const restoreDebug = setEnv("SANDBOXIFY_DEBUG", "1");
    const debugLines = [];
    t.mock.method(console, "error", (line) => {
      debugLines.push(String(line));
    });

    const calls = [];
    let closed = false;
    let counterValue = 0;
    const fakeClient = {
      request(op, payload) {
        calls.push({ op, payload });

        if (op === "load") {
          return Promise.resolve({
            exports: {
              add: { kind: "function", constructable: false },
              repeat: { kind: "function", constructable: false },
              badBatch: { kind: "function", constructable: false },
              Counter: { kind: "function", constructable: true },
              EmptyState: { kind: "function", constructable: true },
              ShapeShift: { kind: "function", constructable: true },
              version: { kind: "value", value: "1.2.3" },
              weird: { kind: "unsupported", valueType: "symbol" },
            },
          });
        }

        if (op === "call") {
          if (payload.exportName === "add") {
            return Promise.resolve({ result: payload.args[0] + payload.args[1] });
          }
          return Promise.resolve({ result: "noop" });
        }

        if (op === "callMany") {
          if (payload.exportName === "add") {
            return Promise.resolve({
              results: payload.argsList.map(([a, b]) => a + b),
            });
          }

          if (payload.exportName === "repeat") {
            return Promise.resolve({
              repeatedResult: {
                count: payload.emptyArgsCount ?? payload.argsList.length,
                value: "same",
              },
            });
          }

          return Promise.resolve({
            repeatedResult: {
              count: -1,
              value: "nope",
            },
          });
        }

        if (op === "construct") {
          if (payload.exportName === "Counter") {
            counterValue = payload.args[0] ?? 0;
            return Promise.resolve({
              instanceId: 7,
              methods: ["increment"],
              state: { value: counterValue },
            });
          }

          if (payload.exportName === "ShapeShift") {
            return Promise.resolve({
              instanceId: 9,
              methods: ["drop"],
              state: { keep: true, remove: "soon" },
            });
          }

          return Promise.resolve({
            instanceId: 8,
            methods: [],
            state: null,
          });
        }

        if (op === "instanceCall") {
          if (payload.instanceId === 9) {
            return Promise.resolve({
              result: "gone",
              state: { keep: true },
            });
          }

          counterValue += payload.args[0] ?? 1;
          return Promise.resolve({
            result: counterValue,
            state: { value: counterValue },
          });
        }

        if (op === "releaseInstance") {
          return Promise.resolve({ released: true });
        }

        throw new Error(`Unexpected op: ${op}`);
      },
      close() {
        closed = true;
      },
    };

    const pool = new RuntimePool({
      buckets: {
        cpu_only: {},
      },
    });
    pool.getClient = (bucketName) => {
      pool.clients.set(bucketName, fakeClient);
      return fakeClient;
    };

    try {
      const moduleA = await pool.getRemoteModule({
        bucket: "cpu_only",
        specifier: "fixture-lib",
        realUrl: "file:///fixture-lib/index.mjs",
        exportNames: [
          "add",
          "repeat",
          "badBatch",
          "Counter",
          "EmptyState",
          "ShapeShift",
          "version",
          "weird",
          "missing",
        ],
      });
      const moduleB = await pool.getRemoteModule({
        bucket: "cpu_only",
        specifier: "fixture-lib",
        realUrl: "file:///fixture-lib/index.mjs",
        exportNames: [
          "add",
          "repeat",
          "badBatch",
          "Counter",
          "EmptyState",
          "ShapeShift",
          "version",
          "weird",
          "missing",
        ],
      });

      assert.equal(moduleA, moduleB);
      assert.equal(moduleA.version, "1.2.3");
      assert.equal(moduleA.missing, undefined);
      assert.equal(moduleA.add.name, "sandboxifyRemoteCallable");
      assert.equal(await moduleA.add(2, 3), 5);
      assert.deepEqual(await moduleA.add.batch([[1, 2], [3, 4]]), [3, 7]);
      assert.deepEqual(await moduleA.repeat.batch([[], []]), ["same", "same"]);
      assert.deepEqual(await moduleA.badBatch.batch([[1]]), []);
      assert.throws(() => moduleA.weird(), /Unsupported export shape/);
      await assert.rejects(async () => new moduleA.add(), /not a constructor/);

      const counter = await new moduleA.Counter(2);
      assert.equal(counter.value, 2);
      assert.equal("increment" in counter, true);
      assert.equal("value" in counter, true);
      assert.equal(counter.__sandboxifyRemoteInstanceId, 7);
      assert.equal(counter[Symbol.toStringTag], undefined);
      assert.equal(Symbol.iterator in counter, false);
      assert.equal(counter.increment, counter.increment);
      assert.equal(await counter.increment(3), 5);
      assert.equal(counter.value, 5);
      assert.equal(counter.missingThing, undefined);
      assert.deepEqual(Object.keys(counter).sort(), ["increment", "value"]);
      assert.equal(
        Object.getOwnPropertyDescriptor(counter, "value").value,
        5,
      );
      assert.equal(Object.getOwnPropertyDescriptor(counter, "missing"), undefined);
      assert.throws(() => {
        counter.value = 10;
      }, /read-only/);

      const empty = await new moduleA.EmptyState();
      assert.deepEqual(Object.keys(empty), []);

      const shapeShift = await new moduleA.ShapeShift();
      assert.deepEqual(Object.keys(shapeShift).sort(), ["drop", "keep", "remove"]);
      assert.equal(await shapeShift.drop(), "gone");
      assert.deepEqual(Object.keys(shapeShift).sort(), ["drop", "keep"]);
      assert.equal(shapeShift.remove, undefined);
    } finally {
      pool.close();
      restoreDebug();
    }

    assert.equal(closed, true);
    assert.ok(calls.some((entry) => entry.op === "callMany" && entry.payload.emptyArgsCount === 2));
    assert.ok(debugLines.some((line) => line.includes("[sandboxify][runtime] loadRemoteModule")));
  },
);

test(
  "RuntimePool reuses real RpcClient instances and rejects unknown buckets",
  { concurrency: false },
  async () => {
    const pool = new RuntimePool({
      buckets: {
        cpu_only: {
          allowNet: false,
          allowFsRead: false,
          allowFsWrite: null,
          allowChildProcess: false,
          allowWorker: false,
          allowAddons: false,
          allowWasi: false,
          allowInspector: false,
          env: {},
        },
      },
    });

    try {
      await assert.rejects(
        pool.loadRemoteModule({
          bucket: "missing",
          specifier: "fixture-lib",
          realUrl: "file:///fixture-lib/index.mjs",
          exportNames: ["default"],
        }),
        /No bucket policy configured/,
      );

      const firstClient = pool.getClient("cpu_only", pool.policy.buckets.cpu_only);
      const secondClient = pool.getClient("cpu_only", pool.policy.buckets.cpu_only);
      assert.equal(firstClient, secondClient);
    } finally {
      pool.close();
    }
  },
);

test(
  "RuntimePool rejects cross-bucket circular load traces before RPC",
  { concurrency: false },
  async () => {
    const pool = new RuntimePool({
      buckets: {
        alpha: {},
        beta: {},
      },
    });

    pool.getClient = () => {
      throw new Error("should not request a client when cycle detection trips");
    };

    try {
      await assert.rejects(
        pool.getRemoteModule({
          bucket: "alpha",
          specifier: "pkg-a",
          realUrl: "file:///pkg-a/index.mjs",
          exportNames: ["default"],
          loadTrace: ["alpha", "beta"],
        }),
        /Cross-bucket circular import detected: alpha -> beta -> alpha/,
      );
    } finally {
      pool.close();
    }
  },
);

test(
  "runtime index caches the pool, resets it, and handles cleanup signals",
  { concurrency: false },
  async (t) => {
    const tmpDir = createTmpDir("sandboxify-runtime-index-");
    const restorePolicyPath = setEnv(
      "SANDBOXIFY_POLICY_PATH",
      path.join(tmpDir, "sandboxify.policy.jsonc"),
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
      packages: {},
    });

    const exitCodes = [];
    t.mock.method(process, "exit", (code) => {
      exitCodes.push(code);
    });

    try {
      const runtimeIndexUrl = new URL("../src/runtime/index.js", import.meta.url);
      const runtime = await import(
        `${runtimeIndexUrl.href}?coverage=${Date.now()}`
      );

      const firstPool = runtime.getRuntimePool();
      const secondPool = runtime.getRuntimePool();
      assert.equal(firstPool, secondPool);

      runtime.resetRuntimePool();
      const resetPool = runtime.getRuntimePool();
      assert.notEqual(resetPool, firstPool);

      resetPool.getRemoteModule = async (payload) => payload;
      assert.deepEqual(
        await runtime.getRemoteModule({
          bucket: "cpu_only",
          specifier: "fixture",
          realUrl: "file:///fixture.mjs",
          exportNames: ["default"],
        }),
        {
          bucket: "cpu_only",
          specifier: "fixture",
          realUrl: "file:///fixture.mjs",
          exportNames: ["default"],
          loadTrace: [],
        },
      );

      process.emit("SIGINT");
      assert.deepEqual(exitCodes, [130]);

      const thirdPool = runtime.getRuntimePool();
      assert.notEqual(thirdPool, resetPool);

      process.emit("SIGTERM");
      assert.deepEqual(exitCodes, [130, 143]);

      runtime.resetRuntimePool();
      runtime.resetRuntimePool();
    } finally {
      restorePolicyPath();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "RpcClient covers happy paths, blob offload, lifecycle cleanup, and failure branches",
  { concurrency: false },
  async (t) => {
    const tmpDir = createTmpDir("sandboxify-rpc-");
    const modulePath = path.join(tmpDir, "rpc-fixture.mjs");
    const moduleUrl = pathToFileURL(modulePath).href;
    writeFile(
      modulePath,
      `
        export function add(a, b) {
          return a + b;
        }

        export function echo(value) {
          return value;
        }

        export class Counter {
          constructor(start = 0) {
            this.value = start;
          }

          increment(delta = 1) {
            this.value += delta;
            return this.value;
          }
        }
      `,
    );

    const restoreThreshold = setEnv("SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES", "1");
    const restoreDebug = setEnv("SANDBOXIFY_DEBUG", "1");
    const restorePolicyPath = setEnv(
      "SANDBOXIFY_POLICY_PATH",
      path.join(tmpDir, "sandboxify.policy.jsonc"),
    );
    const restoreManifestPath = setEnv(
      "SANDBOXIFY_MANIFEST_PATH",
      path.join(tmpDir, "exports.manifest.json"),
    );
    writeJson(path.join(tmpDir, "sandboxify.policy.jsonc"), {
      buckets: {
        rpc_coverage: {},
      },
      packages: {},
    });
    writeJson(path.join(tmpDir, "exports.manifest.json"), {
      version: 1,
      entriesByUrl: {},
      entriesBySpecifier: {},
    });
    const debugLines = [];
    t.mock.method(console, "error", (line) => {
      debugLines.push(String(line));
    });

    const bucketPolicy = {
      allowNet: true,
      allowFsRead: "*",
      allowFsWrite: "not-an-array",
      allowChildProcess: true,
      allowWorker: true,
      allowAddons: true,
      allowWasi: true,
      allowInspector: true,
      env: { FOO: "bar" },
    };

    let client = null;
    let disabledClient = null;
    let errorClient = null;
    let exitClient = null;
    let sendFailClient = null;

    try {
      client = new RpcClient("rpc-coverage", bucketPolicy);

      const hello = await client.request("hello", { bucket: "rpc-coverage" });
      assert.equal(hello.bucket, "rpc-coverage");

      const load = await client.request("load", {
        moduleKey: moduleUrl,
        specifier: "./rpc-fixture.mjs",
        url: moduleUrl,
        exportNames: ["add", "echo", "Counter"],
      });
      assert.equal(load.moduleKey, moduleUrl);

      const call = await client.request("call", {
        moduleKey: moduleUrl,
        exportName: "add",
        args: [2, 3],
      });
      assert.equal(call.result, 5);

      const payload = {
        nested: {
          buffer: Buffer.from("hello"),
          bytes: new Uint8Array([1, 2, 3]),
        },
      };
      const echoed = await client.request("call", {
        moduleKey: moduleUrl,
        exportName: "echo",
        args: [payload],
      });
      assert.equal(echoed.result.nested.buffer.length, 5);
      assert.equal(echoed.result.nested.bytes.byteLength, 3);

      const batched = await client.request("callMany", {
        moduleKey: moduleUrl,
        exportName: "add",
        argsList: [
          [1, 2],
          [3, 4],
        ],
      });
      assert.deepEqual(batched.results, [3, 7]);

      const constructed = await client.request("construct", {
        moduleKey: moduleUrl,
        exportName: "Counter",
        args: [4],
      });
      assert.equal(constructed.state.value, 4);

      const instanceResult = await client.request("instanceCall", {
        instanceId: constructed.instanceId,
        memberName: "increment",
        args: [2],
      });
      assert.equal(instanceResult.result, 6);
      assert.equal(instanceResult.state.value, 6);

      const released = await client.request("releaseInstance", {
        instanceId: constructed.instanceId,
      });
      assert.equal(released.released, true);

      let capturedError = null;
      client.pending.set(999, {
        resolve() {},
        reject(error) {
          capturedError = error;
        },
        cleanupFiles: [path.join(tmpDir, "missing-file.bin")],
      });
      client.onMessage({
        t: "res",
        id: 999,
        ok: false,
        e: {
          name: "RemoteBoom",
          message: "boom",
          stack: "stack-trace",
          code: "ERR_REMOTE",
          data: { a: 1 },
        },
      });
      assert.equal(capturedError.name, "RemoteBoom");
      assert.equal(capturedError.code, "ERR_REMOTE");
      assert.deepEqual(capturedError.data, { a: 1 });
      assert.match(capturedError.stack, /stack-trace/);

      client.onMessage({ t: "noop" });
      client.onMessage({ t: "res", id: 12345, ok: true, v: 1 });

      const cleanupFile = path.join(client.blobStore.dirPath, "cleanup.bin");
      writeFile(cleanupFile, "bye");
      client.pending.set(1000, {
        resolve() {},
        reject() {},
        cleanupFiles: [cleanupFile],
      });
      const failingDirPath = client.blobStore.dirPath;
      const originalRmSync = fs.rmSync;
      t.mock.method(fs, "rmSync", (filePath, options) => {
        if (filePath === failingDirPath) {
          throw new Error("forced cleanup failure");
        }
        return originalRmSync.call(fs, filePath, options);
      });
      client.close();
      client.close();
      assert.equal(fs.existsSync(cleanupFile), false);

      const restoreDisabledThreshold = setEnv(
        "SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES",
        "0",
      );
      disabledClient = new RpcClient("rpc-disabled", {
        allowNet: false,
        allowFsRead: false,
        allowFsWrite: null,
        allowChildProcess: false,
        allowWorker: false,
        allowAddons: false,
        allowWasi: false,
        allowInspector: false,
        env: {},
      });
      assert.equal(disabledClient.blobStore.enabled, false);
      assert.equal(
        (await disabledClient.request("hello", {})).bucket,
        "rpc-disabled",
      );
      disabledClient.close();
      restoreDisabledThreshold();

      errorClient = new RpcClient("rpc-error", {
        allowNet: false,
        allowFsRead: [tmpDir],
        allowFsWrite: [],
        allowChildProcess: false,
        allowWorker: false,
        allowAddons: false,
        allowWasi: false,
        allowInspector: false,
        env: {},
      });
      let processError = null;
      errorClient.pending.set(1, {
        resolve() {},
        reject(error) {
          processError = error;
        },
        cleanupFiles: [],
      });
      errorClient.proc.emit("error", new Error("synthetic process error"));
      assert.match(processError.message, /synthetic process error/);
      try {
        errorClient.proc.kill("SIGTERM");
      } catch {}
      fs.rmSync(errorClient.blobStore.dirPath, { recursive: true, force: true });

      exitClient = new RpcClient("rpc-exit", {
        allowNet: false,
        allowFsRead: [tmpDir],
        allowFsWrite: [],
        allowChildProcess: false,
        allowWorker: false,
        allowAddons: false,
        allowWasi: false,
        allowInspector: false,
        env: {},
      });
      const exitPromise = exitClient.request("hello", {});
      exitClient.proc.kill("SIGKILL");
      await assert.rejects(exitPromise, /Sandbox process exited/);

      sendFailClient = new RpcClient("rpc-send-fail", {
        allowNet: false,
        allowFsRead: [tmpDir],
        allowFsWrite: [],
        allowChildProcess: false,
        allowWorker: false,
        allowAddons: false,
        allowWasi: false,
        allowInspector: false,
        env: {},
      });
      sendFailClient.proc.disconnect();
      await assert.rejects(
        sendFailClient.request("hello", {}),
        /channel closed|IPC channel is already disconnected|disconnected/i,
      );
      sendFailClient.close();

      client = new RpcClient("rpc-exited", {
        allowNet: false,
        allowFsRead: [tmpDir],
        allowFsWrite: [],
        allowChildProcess: false,
        allowWorker: false,
        allowAddons: false,
        allowWasi: false,
        allowInspector: false,
        env: {},
      });
      client.exited = true;
      await assert.rejects(
        client.request("hello", {}),
        /Sandbox process is not available/,
      );
      try {
        client.proc.kill("SIGTERM");
      } catch {}
      fs.rmSync(client.blobStore.dirPath, { recursive: true, force: true });
    } finally {
      restoreThreshold();
      restoreDebug();
      restorePolicyPath();
      restoreManifestPath();

      for (const maybeClient of [
        client,
        disabledClient,
        errorClient,
        exitClient,
        sendFailClient,
      ]) {
        if (!maybeClient) {
          continue;
        }

        try {
          maybeClient.close();
        } catch {}
        try {
          maybeClient.proc.kill("SIGKILL");
        } catch {}
        try {
          fs.rmSync(maybeClient.blobStore?.dirPath, {
            recursive: true,
            force: true,
          });
        } catch {}
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.ok(debugLines.some((line) => line.includes("[sandboxify][rpc] spawn")));
  },
);

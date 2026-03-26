import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_REFERENCE_TAG,
  getRemoteReference,
} from "./reference.js";

const HOST_ENTRY = fileURLToPath(new URL("../host/index.js", import.meta.url));
const NODE_MAJOR = Number.parseInt(
  process.versions.node.split(".")[0] ?? "0",
  10,
);

export class RpcClient {
  constructor(bucketName, bucketPolicy) {
    this.bucketName = bucketName;
    this.bucketPolicy = bucketPolicy;
    this.nextId = 1;
    this.nextLocalHandleId = 1;
    this.pending = new Map();
    this.localHandles = new Map();
    this.localHandleIds = new WeakMap();
    this.remoteHandleCache = new Map();
    this.exited = false;
    this.exitReason = null;
    this.isRefed = true;
    this.blobStore = createBlobStore(bucketName);
    this.proc = spawnSandboxHost(bucketName, bucketPolicy, this.blobStore);
    this.syncRefState();

    this.proc.on("message", (msg) => this.onMessage(msg));
    this.proc.on("error", (error) => {
      this.exited = true;
      this.exitReason = error;
      for (const [, pending] of this.pending) {
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      const reason = new Error(
        `Sandbox process exited for bucket ${bucketName} (code=${code}, signal=${signal})`,
      );
      this.exitReason = reason;
      for (const [, pending] of this.pending) {
        pending.reject(reason);
      }
      this.pending.clear();
    });
  }

  close() {
    if (this.exited) {
      return;
    }

    this.exited = true;
    for (const [, pending] of this.pending) {
      for (const filePath of pending.cleanupFiles ?? []) {
        safeUnlink(filePath);
      }
    }
    this.pending.clear();

    try {
      this.proc.disconnect();
    } catch {}

    try {
      this.proc.kill("SIGTERM");
    } catch {}

    cleanupBlobStore(this.blobStore);
    this.localHandles.clear();
    this.remoteHandleCache.clear();
  }

  async request(op, payload) {
    if (this.exited) {
      throw new Error(
        `Sandbox process is not available for bucket ${this.bucketName}`,
      );
    }

    const prepared = await preparePayload(this, op, payload, this.blobStore);
    const id = this.nextId++;
    const message = { t: "req", id, op, p: prepared.payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        cleanupFiles: prepared.cleanupFiles,
      });
      this.syncRefState();
      this.proc.send(message, (error) => {
        if (error) {
          const current = this.pending.get(id);
          this.pending.delete(id);
          for (const filePath of current?.cleanupFiles ?? []) {
            safeUnlink(filePath);
          }
          this.syncRefState();
          reject(normalizeRequestError(this, error));
        }
      });
    });
  }

  onMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.t === "req") {
      this.onRequest(message);
      return;
    }

    if (message.t !== "res") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    for (const filePath of pending.cleanupFiles ?? []) {
      safeUnlink(filePath);
    }
    this.syncRefState();

    if (message.ok) {
      pending.resolve(message.v);
      return;
    }

    pending.reject(deserializeError(message.e));
  }

  onRequest(message) {
    const id = message.id;
    if (!Number.isInteger(id)) {
      return;
    }

    try {
      const value = this.dispatchLocal(message.op, message.p ?? {});
      if (isThenable(value)) {
        value.then(
          (resolvedValue) => {
            this.sendResponse(id, true, resolvedValue);
          },
          (error) => {
            this.sendResponse(id, false, serializeError(error));
          },
        );
        return;
      }

      this.sendResponse(id, true, value);
    } catch (error) {
      this.sendResponse(id, false, serializeError(error));
    }
  }

  dispatchLocal(op, payload) {
    if (op === "clientHandleCall") {
      return this.callLocalHandle(payload);
    }

    throw new Error(`Unknown sandbox callback operation: ${op}`);
  }

  async callLocalHandle({ handleId, args }) {
    const target = this.localHandles.get(handleId);
    if (typeof target !== "function") {
      throw new Error(`Client handle is not callable: ${handleId}`);
    }

    return {
      result: await target(...(Array.isArray(args) ? args : [])),
    };
  }

  registerLocalHandle(value) {
    if (value == null || typeof value !== "function") {
      return null;
    }

    if (this.localHandleIds.has(value)) {
      return this.localHandleIds.get(value);
    }

    const handleId = this.nextLocalHandleId++;
    this.localHandleIds.set(value, handleId);
    this.localHandles.set(handleId, value);
    return handleId;
  }

  sendResponse(id, ok, value) {
    try {
      this.proc.send(
        ok
          ? { t: "res", id, ok: true, v: value }
          : { t: "res", id, ok: false, e: value },
      );
    } catch {}
  }

  syncRefState() {
    const shouldBeRefed = this.pending.size > 0;
    if (shouldBeRefed === this.isRefed) {
      return;
    }

    this.isRefed = shouldBeRefed;

    if (shouldBeRefed) {
      this.proc.ref();
      this.proc.channel?.ref?.();
      return;
    }

    this.proc.unref();
    this.proc.channel?.unref?.();
  }
}

function isThenable(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function spawnSandboxHost(bucketName, bucketPolicy, blobStore) {
  const permissionArgs = buildPermissionArgs(bucketPolicy, blobStore?.dirPath);
  const args = [...permissionArgs, HOST_ENTRY];

  debugLog("spawn", { bucketName, args });

  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...bucketPolicy.env,
      SANDBOXIFY_BUCKET: bucketName,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
}

function buildPermissionArgs(bucket, blobReadDir) {
  const args = ["--permission"];
  const internalSrcDir = path.resolve(path.dirname(HOST_ENTRY), "..");
  const blobRootDir = path.join(os.tmpdir(), "sandboxify-ipc");
  args.push(`--allow-fs-read=${internalSrcDir}`);
  args.push(`--allow-fs-read=${blobRootDir}`);
  args.push(`--allow-fs-write=${blobRootDir}`);

  const policyPath = resolveConfiguredPath(
    process.env.SANDBOXIFY_POLICY_PATH ?? "./sandboxify.policy.jsonc",
  );
  if (policyPath) {
    args.push(`--allow-fs-read=${policyPath}`);
  }

  const manifestPath = resolveConfiguredPath(
    process.env.SANDBOXIFY_MANIFEST_PATH ?? "./.sandboxify/exports.manifest.json",
  );
  if (manifestPath) {
    args.push(`--allow-fs-read=${manifestPath}`);
  }

  if (blobReadDir) {
    args.push(`--allow-fs-read=${blobReadDir}`);
    args.push(`--allow-fs-write=${blobReadDir}`);
  }

  pushFsArgs(args, "--allow-fs-read", bucket.allowFsRead);
  pushFsArgs(args, "--allow-fs-write", bucket.allowFsWrite);

  if (NODE_MAJOR >= 25 && bucket.allowNet === true) {
    args.push("--allow-net");
  }

  if (bucket.allowChildProcess) args.push("--allow-child-process");
  if (bucket.allowWorker) args.push("--allow-worker");
  if (bucket.allowAddons) args.push("--allow-addons");
  if (bucket.allowWasi) args.push("--allow-wasi");
  if (bucket.allowInspector) args.push("--allow-inspector");

  return args;
}

function resolveConfiguredPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return path.resolve(process.cwd(), value);
}

function pushFsArgs(args, flag, value) {
  if (value === false || value == null) {
    return;
  }

  if (value === "*") {
    args.push(`${flag}=*`);
    return;
  }

  if (!Array.isArray(value)) {
    return;
  }

  for (const entry of value) {
    args.push(`${flag}=${entry}`);
  }
}

function deserializeError(raw) {
  const error = new Error(raw?.message ?? "Sandbox RPC error");
  error.name = raw?.name ?? "SandboxRpcError";
  if (raw?.stack) {
    error.stack = raw.stack;
  }
  if (raw?.code) {
    error.code = raw.code;
  }
  if (raw?.data) {
    error.data = raw.data;
  }
  return error;
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    data: error?.data,
  };
}

function normalizeRequestError(client, error) {
  if (client.exitReason) {
    return client.exitReason;
  }

  if (error?.code === "EPIPE") {
    return new Error(
      `Sandbox process exited for bucket ${client.bucketName} (code=${client.proc.exitCode ?? "unknown"}, signal=${client.proc.signalCode ?? "unknown"})`,
    );
  }

  return error;
}

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== "1") {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.error(`[sandboxify][rpc] ${event}${payload}`);
}

function createBlobStore(bucketName) {
  const configured = Number.parseInt(
    process.env.SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES ?? "262144",
    10,
  );
  const thresholdBytes = Number.isFinite(configured) ? configured : 262144;

  if (thresholdBytes <= 0) {
    return {
      enabled: false,
      thresholdBytes: 0,
      dirPath: null,
    };
  }

  const safeBucket = bucketName.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
  const dirPath = path.join(
    os.tmpdir(),
    "sandboxify-ipc",
    String(process.pid),
    safeBucket,
  );
  fs.mkdirSync(dirPath, { recursive: true });

  return {
    enabled: true,
    thresholdBytes,
    dirPath,
  };
}

function cleanupBlobStore(blobStore) {
  if (!blobStore?.enabled || !blobStore.dirPath) {
    return;
  }

  try {
    fs.rmSync(blobStore.dirPath, { recursive: true, force: true });
  } catch {
    // noop
  }
}

async function preparePayload(client, op, payload, blobStore) {
  const encodedPayload = await encodeOutgoingPayload(client, payload);

  if (!blobStore?.enabled) {
    return { payload: encodedPayload, cleanupFiles: [] };
  }

  if (op === "call") {
    return prepareBlobPayload(encodedPayload, "args", blobStore);
  }

  if (op === "callMany") {
    return prepareBlobPayload(encodedPayload, "argsList", blobStore);
  }

  if (op === "construct" || op === "handleCall" || op === "handleInvoke") {
    return prepareBlobPayload(encodedPayload, "args", blobStore);
  }

  return { payload: encodedPayload, cleanupFiles: [] };
}

function prepareBlobPayload(payload, key, blobStore) {
  const cleanupFiles = [];
  const encodedValue = encodeLargeBinaryValues(
    payload?.[key],
    blobStore,
    cleanupFiles,
  );

  if (cleanupFiles.length === 0) {
    return { payload, cleanupFiles };
  }

  return {
    payload: {
      ...(payload ?? {}),
      [key]: encodedValue,
      hasBlobRefs: true,
    },
    cleanupFiles,
  };
}

async function encodeOutgoingPayload(client, payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const out = Array.isArray(payload) ? [] : {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = await encodeOutgoingValue(client, value);
  }
  return out;
}

async function encodeOutgoingValue(client, value) {
  const remoteReference = getRemoteReference(value);
  if (remoteReference) {
    if (remoteReference.client !== client) {
      throw new Error(
        "Remote references can only be passed back to the bucket that owns them",
      );
    }

    return remoteReference.serialize();
  }

  if (typeof value === "function") {
    const handleId = client.registerLocalHandle(value);
    return {
      [CLIENT_REFERENCE_TAG]: 1,
      handleId,
      source: getFunctionSource(value),
    };
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => encodeOutgoingValue(client, entry)));
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = await encodeOutgoingValue(client, entry);
    }
    return out;
  }

  return value;
}

function encodeLargeBinaryValues(value, blobStore, cleanupFiles) {
  if (Buffer.isBuffer(value)) {
    if (value.byteLength < blobStore.thresholdBytes) {
      return value;
    }

    const filePath = writeBlobFile(blobStore, value);
    cleanupFiles.push(filePath);
    return {
      __sandboxifyBlobRef: 1,
      as: "buffer",
      file: filePath,
      byteLength: value.byteLength,
    };
  }

  if (value instanceof Uint8Array) {
    if (value.byteLength < blobStore.thresholdBytes) {
      return value;
    }

    const filePath = writeBlobFile(
      blobStore,
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    );
    cleanupFiles.push(filePath);
    return {
      __sandboxifyBlobRef: 1,
      as: "uint8array",
      file: filePath,
      byteLength: value.byteLength,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      encodeLargeBinaryValues(entry, blobStore, cleanupFiles),
    );
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = encodeLargeBinaryValues(entry, blobStore, cleanupFiles);
    }
    return out;
  }

  return value;
}

function writeBlobFile(blobStore, content) {
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.bin`;
  const filePath = path.join(blobStore.dirPath, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // noop
  }
}

function isPlainObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function getFunctionSource(value) {
  try {
    const source = Function.prototype.toString.call(value);
    return typeof source === "string" && source.length > 0 ? source : null;
  } catch {
    return null;
  }
}

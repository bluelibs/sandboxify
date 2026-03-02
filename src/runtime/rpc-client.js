import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class RpcClient {
  constructor(bucketName, bucketPolicy) {
    this.bucketName = bucketName;
    this.bucketPolicy = bucketPolicy;
    this.nextId = 1;
    this.pending = new Map();
    this.helloPromise = null;
    this.exited = false;
    this.blobStore = createBlobStore(bucketName);
    this.proc = spawnSandboxHost(bucketName, bucketPolicy, this.blobStore);
    this.updateRefState();

    this.proc.on('message', (msg) => this.onMessage(msg));
    this.proc.on('error', (error) => {
      this.exited = true;
      for (const [, pending] of this.pending) {
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      const reason = new Error(`Sandbox process exited for bucket ${bucketName} (code=${code}, signal=${signal})`);
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
      this.proc.kill('SIGTERM');
    } catch {}

    cleanupBlobStore(this.blobStore);
  }

  ensureHello() {
    if (!this.helloPromise) {
      this.helloPromise = this.request('hello', { bucket: this.bucketName });
    }

    return this.helloPromise;
  }

  request(op, payload) {
    if (this.exited) {
      return Promise.reject(new Error(`Sandbox process is not available for bucket ${this.bucketName}`));
    }

    const id = this.nextId++;
    const prepared = preparePayload(op, payload, this.blobStore);
    const message = { t: 'req', id, op, p: prepared.payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, cleanupFiles: prepared.cleanupFiles });
      this.updateRefState();
      this.proc.send(message, (error) => {
        if (error) {
          const current = this.pending.get(id);
          this.pending.delete(id);
          for (const filePath of current?.cleanupFiles ?? []) {
            safeUnlink(filePath);
          }
          this.updateRefState();
          reject(error);
        }
      });
    });
  }

  onMessage(message) {
    if (!message || message.t !== 'res') {
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
    this.updateRefState();

    if (message.ok) {
      pending.resolve(message.v);
      return;
    }

    pending.reject(deserializeError(message.e));
  }

  updateRefState() {
    if (this.pending.size > 0) {
      this.proc.ref();
      this.proc.channel?.ref?.();
      return;
    }

    this.proc.unref();
    this.proc.channel?.unref?.();
  }
}

function spawnSandboxHost(bucketName, bucketPolicy, blobStore) {
  const hostEntry = fileURLToPath(new URL('../host/index.js', import.meta.url));
  const permissionArgs = buildPermissionArgs(bucketPolicy, hostEntry, blobStore?.dirPath ?? null);
  const args = [...permissionArgs, hostEntry];

  debugLog('spawn', { bucketName, args });

  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...bucketPolicy.env,
      SANDBOXIFY_BUCKET: bucketName,
      SANDBOXIFY_IPC_BLOB_READ_DIR: blobStore?.dirPath ?? '',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
  });
}

function buildPermissionArgs(bucket, hostEntry, blobReadDir) {
  const args = ['--permission'];
  const hostDir = path.dirname(hostEntry);
  args.push(`--allow-fs-read=${hostDir}`);

  if (blobReadDir) {
    args.push(`--allow-fs-read=${blobReadDir}`);
  }

  pushFsArgs(args, '--allow-fs-read', bucket.allowFsRead);
  pushFsArgs(args, '--allow-fs-write', bucket.allowFsWrite);

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor >= 25 && bucket.allowNet === true) {
    args.push('--allow-net');
  }

  if (bucket.allowChildProcess) args.push('--allow-child-process');
  if (bucket.allowWorker) args.push('--allow-worker');
  if (bucket.allowAddons) args.push('--allow-addons');
  if (bucket.allowWasi) args.push('--allow-wasi');
  if (bucket.allowInspector) args.push('--allow-inspector');

  return args;
}

function pushFsArgs(args, flag, value) {
  if (value === false || value == null) {
    return;
  }

  if (value === '*') {
    args.push(`${flag}=*`);
    return;
  }

  if (!Array.isArray(value)) {
    return;
  }

  for (const entry of value) {
    const normalized = path.resolve(process.cwd(), entry);
    args.push(`${flag}=${normalized}`);
  }
}

function deserializeError(raw) {
  const error = new Error(raw?.message ?? 'Sandbox RPC error');
  error.name = raw?.name ?? 'SandboxRpcError';
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

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== '1') {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.error(`[sandboxify][rpc] ${event}${payload}`);
}

function createBlobStore(bucketName) {
  const configured = Number.parseInt(process.env.SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES ?? '262144', 10);
  const thresholdBytes = Number.isFinite(configured) ? configured : 262144;

  if (thresholdBytes <= 0) {
    return {
      enabled: false,
      thresholdBytes: 0,
      dirPath: null,
    };
  }

  const safeBucket = bucketName.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  const dirPath = path.join(os.tmpdir(), 'sandboxify-ipc', String(process.pid), safeBucket);
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

function preparePayload(op, payload, blobStore) {
  if (op !== 'call' || !blobStore?.enabled) {
    return { payload, cleanupFiles: [] };
  }

  const cleanupFiles = [];
  const args = Array.isArray(payload?.args) ? payload.args : [];
  const encodedArgs = encodeLargeBinaryValues(args, blobStore, cleanupFiles);

  return {
    payload: {
      ...payload,
      args: encodedArgs,
    },
    cleanupFiles,
  };
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
      as: 'buffer',
      file: filePath,
      byteLength: value.byteLength,
    };
  }

  if (value instanceof Uint8Array) {
    if (value.byteLength < blobStore.thresholdBytes) {
      return value;
    }

    const filePath = writeBlobFile(blobStore, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    cleanupFiles.push(filePath);
    return {
      __sandboxifyBlobRef: 1,
      as: 'uint8array',
      file: filePath,
      byteLength: value.byteLength,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => encodeLargeBinaryValues(entry, blobStore, cleanupFiles));
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
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.bin`;
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
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

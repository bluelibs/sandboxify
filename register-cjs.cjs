const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const Module = require('node:module');

const CJS_SYNC_EXPERIMENTAL_ENABLED = process.env.SANDBOXIFY_CJS_SYNC_EXPERIMENTAL === '1';

function installCjsRequireHook() {
  const policyPath = process.env.SANDBOXIFY_POLICY_PATH ?? './sandboxify.policy.jsonc';
  const manifestPath = process.env.SANDBOXIFY_MANIFEST_PATH ?? './.sandboxify/exports.manifest.json';
  const policy = loadPolicySync(policyPath);
  const matcher = createPolicyMatcher(policy);
  const manifest = readManifestSafe(manifestPath);
  const runtime = new CjsRuntimePool(policy);
  const originalLoad = Module._load;

  Module._load = function sandboxifyLoad(request, parent, isMain) {
    const parentUrl = parent?.filename ? pathToFileURL(parent.filename).href : '';
    const bucket = matcher.match(request, parentUrl);
    if (!bucket) {
      return originalLoad.apply(this, arguments);
    }

    const resolved = resolveSpecifier(request, parent, isMain);
    const realUrl = resolved ? pathToFileURL(resolved).href : request;
    const manifestEntry = getManifestEntry(manifest, realUrl, request);
    const exportNames = normalizeExportNames(manifestEntry?.exportNames);

    return runtime.createRequireProxy({
      bucket,
      specifier: request,
      realUrl,
      exportNames,
    });
  };

  registerCleanupHooks(runtime);
}

class CjsRuntimePool {
  constructor(policy) {
    this.policy = policy;
    this.syncExperimental = CJS_SYNC_EXPERIMENTAL_ENABLED;
    this.clients = new Map();
    this.syncInvokers = new Map();
    this.proxyCache = new Map();
    this.loadPromiseByKey = new Map();
    this.exportDescriptorsByKey = new Map();
  }

  createRequireProxy({ bucket, specifier, realUrl, exportNames }) {
    const cacheKey = `${bucket}::${realUrl}`;
    const requestedNames = normalizeExportNames(exportNames);
    if (this.proxyCache.has(cacheKey)) {
      return this.proxyCache.get(cacheKey);
    }

    if (this.syncExperimental) {
      return this.createExperimentalSyncProxy({
        cacheKey,
        bucket,
        specifier,
        realUrl,
        exportNames: requestedNames,
      });
    }

    const client = this.getClient(bucket);
    const moduleKey = realUrl;
    const ensureLoaded = () => {
      if (this.loadPromiseByKey.has(cacheKey)) {
        return this.loadPromiseByKey.get(cacheKey);
      }

      const loadPromise = client
        .ensureHello()
        .then(() =>
          client.request('load', {
            moduleKey,
            specifier,
            url: realUrl,
            exportNames: requestedNames,
          }),
        )
        .then((response) => {
          this.exportDescriptorsByKey.set(cacheKey, response?.exports ?? {});
          return response;
        });

      this.loadPromiseByKey.set(cacheKey, loadPromise);
      return loadPromise;
    };

    const invoke = async (exportName, args) => {
      await ensureLoaded();

      const descriptors = this.exportDescriptorsByKey.get(cacheKey) ?? {};
      const descriptor = descriptors[exportName];
      if (!descriptor) {
        throw new Error(`Export "${String(exportName)}" was not found for ${specifier}`);
      }

      if (descriptor.kind !== 'function') {
        throw new Error(
          `CJS require proxy can only call function exports. "${String(exportName)}" is ${descriptor.kind ?? 'unknown'}.`,
        );
      }

      const response = await client.request('call', {
        moduleKey,
        exportName,
        args: Array.isArray(args) ? args : [],
      });

      return response?.result;
    };

    const functionCache = new Map();
    const makeCallable = (exportName) => {
      if (functionCache.has(exportName)) {
        return functionCache.get(exportName);
      }

      const fn = (...args) => invoke(exportName, args);
      functionCache.set(exportName, fn);
      return fn;
    };

    const target = Object.create(null);
    for (const exportName of requestedNames) {
      target[exportName] = makeCallable(exportName);
    }

    const proxy = new Proxy(target, {
      get(obj, prop) {
        if (prop === '__esModule') {
          return true;
        }

        if (prop === 'then') {
          return undefined;
        }

        if (typeof prop !== 'string') {
          return Reflect.get(obj, prop);
        }

        if (prop in obj) {
          return obj[prop];
        }

        const generated = makeCallable(prop);
        obj[prop] = generated;
        return generated;
      },
    });

    this.proxyCache.set(cacheKey, proxy);
    return proxy;
  }

  createExperimentalSyncProxy({ cacheKey, bucket, specifier, realUrl, exportNames }) {
    if (this.proxyCache.has(cacheKey)) {
      return this.proxyCache.get(cacheKey);
    }

    const syncInvoker = this.getSyncInvoker(bucket);
    const moduleKey = realUrl;
    const functionCache = new Map();
    const requestedNames = normalizeExportNames(exportNames);

    const makeCallable = (exportName) => {
      if (functionCache.has(exportName)) {
        return functionCache.get(exportName);
      }

      const fn = (...args) =>
        syncInvoker.call({
          moduleKey,
          specifier,
          url: realUrl,
          exportName,
          args: Array.isArray(args) ? args : [],
        });

      functionCache.set(exportName, fn);
      return fn;
    };

    const target = Object.create(null);
    for (const exportName of requestedNames) {
      target[exportName] = makeCallable(exportName);
    }

    const proxy = new Proxy(target, {
      get(obj, prop) {
        if (prop === '__esModule') {
          return true;
        }

        if (prop === 'then') {
          return undefined;
        }

        if (typeof prop !== 'string') {
          return Reflect.get(obj, prop);
        }

        if (prop in obj) {
          return obj[prop];
        }

        const generated = makeCallable(prop);
        obj[prop] = generated;
        return generated;
      },
    });

    this.proxyCache.set(cacheKey, proxy);
    return proxy;
  }

  getClient(bucketName) {
    if (this.clients.has(bucketName)) {
      return this.clients.get(bucketName);
    }

    const bucketPolicy = this.policy.buckets[bucketName];
    if (!bucketPolicy) {
      throw new Error(`No bucket policy configured for ${bucketName}`);
    }

    const client = new CjsRpcClient(bucketName, bucketPolicy);
    this.clients.set(bucketName, client);
    return client;
  }

  getSyncInvoker(bucketName) {
    if (this.syncInvokers.has(bucketName)) {
      return this.syncInvokers.get(bucketName);
    }

    const bucketPolicy = this.policy.buckets[bucketName];
    if (!bucketPolicy) {
      throw new Error(`No bucket policy configured for ${bucketName}`);
    }

    const invoker = new CjsSyncInvoker(bucketName, bucketPolicy);
    this.syncInvokers.set(bucketName, invoker);
    return invoker;
  }

  close() {
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.syncInvokers.clear();
    this.proxyCache.clear();
    this.loadPromiseByKey.clear();
    this.exportDescriptorsByKey.clear();
  }
}

class CjsSyncInvoker {
  constructor(bucketName, bucketPolicy) {
    this.bucketName = bucketName;
    this.bucketPolicy = bucketPolicy;
  }

  call(payload) {
    const response = runSyncSandboxCall(this.bucketName, this.bucketPolicy, payload);
    return response?.result;
  }
}

class CjsRpcClient {
  constructor(bucketName, bucketPolicy) {
    this.bucketName = bucketName;
    this.nextId = 1;
    this.pending = new Map();
    this.helloPromise = null;
    this.exited = false;
    this.proc = spawnSandboxHost(bucketName, bucketPolicy);
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
    this.pending.clear();

    try {
      this.proc.disconnect();
    } catch {}

    try {
      this.proc.kill('SIGTERM');
    } catch {}
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
    const message = { t: 'req', id, op, p: payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.updateRefState();
      this.proc.send(message, (error) => {
        if (error) {
          this.pending.delete(id);
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

function spawnSandboxHost(bucketName, bucketPolicy) {
  const hostEntry = path.resolve(__dirname, 'src', 'host', 'index.js');
  const args = [...buildPermissionArgs(bucketPolicy, hostEntry), hostEntry];

  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...bucketPolicy.env,
      SANDBOXIFY_BUCKET: bucketName,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
  });
}

function runSyncSandboxCall(bucketName, bucketPolicy, payload) {
  const hostEntry = path.resolve(__dirname, 'src', 'host', 'sync-call.js');
  const args = [...buildPermissionArgs(bucketPolicy, hostEntry), hostEntry];
  const requestWire = JSON.stringify(encodeSyncWireValue(payload));

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...bucketPolicy.env,
      SANDBOXIFY_BUCKET: bucketName,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    input: requestWire,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Experimental sync sandbox call failed for bucket ${bucketName} (status=${result.status}): ${String(result.stderr || '').trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`Experimental sync sandbox call returned invalid JSON: ${String(result.stdout || '').trim()}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Experimental sync sandbox call returned empty response');
  }

  if (parsed.ok !== true) {
    throw deserializeError(parsed.error);
  }

  return decodeSyncWireValue(parsed.value);
}

function encodeSyncWireValue(value) {
  if (Buffer.isBuffer(value)) {
    return {
      __sandboxifyType: 'buffer',
      base64: value.toString('base64'),
    };
  }

  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => encodeSyncWireValue(entry));
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = encodeSyncWireValue(entry);
    }
    return output;
  }

  throw new Error(
    `Experimental CJS sync mode only supports JSON-compatible values and Buffer payloads. Unsupported type: ${value?.constructor?.name ?? typeof value}`,
  );
}

function decodeSyncWireValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => decodeSyncWireValue(entry));
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    if (value.__sandboxifyType === 'buffer') {
      return Buffer.from(value.base64 ?? '', 'base64');
    }

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = decodeSyncWireValue(entry);
    }
    return output;
  }

  throw new Error('Experimental CJS sync mode returned unsupported wire value');
}

function buildPermissionArgs(bucket, hostEntry) {
  const args = ['--permission'];
  const hostDir = path.dirname(hostEntry);
  args.push(`--allow-fs-read=${hostDir}`);

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

function resolveSpecifier(specifier, parent, isMain) {
  try {
    const resolved = Module._resolveFilename(specifier, parent, isMain);
    if (typeof resolved !== 'string') {
      return null;
    }
    if (!path.isAbsolute(resolved)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function readManifestSafe(manifestPath) {
  try {
    const absolutePath = path.resolve(process.cwd(), manifestPath);
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    return {
      entriesByUrl: {},
      entriesBySpecifier: {},
    };
  }
}

function getManifestEntry(manifest, realUrl, specifier) {
  return manifest?.entriesByUrl?.[realUrl] ?? manifest?.entriesBySpecifier?.[specifier] ?? null;
}

function normalizeExportNames(exportNames) {
  if (!Array.isArray(exportNames) || exportNames.length === 0) {
    return ['default'];
  }

  const unique = [];
  const seen = new Set();

  for (const exportName of exportNames) {
    if (typeof exportName !== 'string') {
      continue;
    }

    if (seen.has(exportName)) {
      continue;
    }

    seen.add(exportName);
    unique.push(exportName);
  }

  if (!seen.has('default')) {
    unique.unshift('default');
  }

  return unique;
}

function loadPolicySync(policyPath) {
  const absolutePath = path.resolve(process.cwd(), policyPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = parseJsonc(raw);
  return normalizePolicy(parsed);
}

function normalizePolicy(policy) {
  const buckets = {};
  const inputBuckets = policy?.buckets ?? {};
  const importerRules = [];

  for (const [bucketName, bucketValue] of Object.entries(inputBuckets)) {
    buckets[bucketName] = normalizeBucket(bucketValue);
  }

  const packageMappings = [];
  const inputPackages = policy?.packages ?? {};

  for (const [pattern, bucketName] of Object.entries(inputPackages)) {
    if (!buckets[bucketName]) {
      throw new Error(`Policy references unknown bucket \"${bucketName}\" for pattern \"${pattern}\"`);
    }

    if (pattern.endsWith('*')) {
      packageMappings.push({ type: 'wildcard', pattern, prefix: pattern.slice(0, -1), bucket: bucketName });
    } else {
      packageMappings.push({ type: 'exact', pattern, bucket: bucketName });
    }
  }

  packageMappings.sort((a, b) => {
    if (a.type === 'exact' && b.type !== 'exact') return -1;
    if (a.type !== 'exact' && b.type === 'exact') return 1;
    if (a.type === 'wildcard' && b.type === 'wildcard') {
      return b.prefix.length - a.prefix.length;
    }
    return 0;
  });

  const inputImporterRules = Array.isArray(policy?.importerRules) ? policy.importerRules : [];
  for (const rule of inputImporterRules) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }

    const bucketName = rule.bucket;
    if (!buckets[bucketName]) {
      throw new Error(`Policy importerRules references unknown bucket "${bucketName}"`);
    }

    const importerPattern = typeof rule.importer === 'string' ? rule.importer : '*';
    const specifierPattern = typeof rule.specifier === 'string' ? rule.specifier : '*';

    importerRules.push(normalizeImporterRule({
      importerPattern,
      specifierPattern,
      bucket: bucketName,
    }));
  }

  importerRules.sort(compareImporterRules);

  return {
    buckets,
    packageMappings,
    importerRules,
  };
}

function createPolicyMatcher(policy) {
  const exact = new Map();
  const wildcard = [];
  const importerRules = Array.isArray(policy.importerRules) ? policy.importerRules : [];

  for (const mapping of policy.packageMappings ?? []) {
    if (mapping.type === 'exact') {
      exact.set(mapping.pattern, mapping.bucket);
    } else {
      wildcard.push(mapping);
    }
  }

  wildcard.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    match(specifier, parentUrl = '') {
      if (importerRules.length > 0) {
        for (const rule of importerRules) {
          if (!patternMatches(rule.specifierMatcher, specifier)) {
            continue;
          }

          if (!patternMatches(rule.importerMatcher, parentUrl || '')) {
            continue;
          }

          return rule.bucket;
        }
      }

      if (exact.has(specifier)) {
        return exact.get(specifier);
      }

      for (const mapping of wildcard) {
        if (specifier.startsWith(mapping.prefix)) {
          return mapping.bucket;
        }
      }

      return null;
    },
  };
}

function normalizeImporterRule({ importerPattern, specifierPattern, bucket }) {
  return {
    bucket,
    importerPattern,
    specifierPattern,
    importerMatcher: toPatternMatcher(importerPattern),
    specifierMatcher: toPatternMatcher(specifierPattern),
  };
}

function compareImporterRules(a, b) {
  if (a.specifierMatcher.type !== b.specifierMatcher.type) {
    return a.specifierMatcher.type === 'exact' ? -1 : 1;
  }

  if (a.specifierMatcher.anchorLength !== b.specifierMatcher.anchorLength) {
    return b.specifierMatcher.anchorLength - a.specifierMatcher.anchorLength;
  }

  if (a.importerMatcher.type !== b.importerMatcher.type) {
    return a.importerMatcher.type === 'exact' ? -1 : 1;
  }

  return b.importerMatcher.anchorLength - a.importerMatcher.anchorLength;
}

function toPatternMatcher(pattern) {
  if (pattern === '*') {
    return { type: 'any', anchorLength: 0, anchor: '' };
  }

  if (pattern.endsWith('*')) {
    const anchor = pattern.slice(0, -1);
    return { type: 'prefix', anchorLength: anchor.length, anchor };
  }

  return { type: 'exact', anchorLength: pattern.length, anchor: pattern };
}

function patternMatches(matcher, value) {
  if (matcher.type === 'any') {
    return true;
  }

  if (matcher.type === 'prefix') {
    return value.startsWith(matcher.anchor);
  }

  return value === matcher.anchor;
}

function normalizeBucket(bucket = {}) {
  return {
    allowNet: normalizeAllowNet(bucket.allowNet),
    allowFsRead: normalizePathList(bucket.allowFsRead),
    allowFsWrite: normalizePathList(bucket.allowFsWrite),
    allowChildProcess: Boolean(bucket.allowChildProcess),
    allowWorker: Boolean(bucket.allowWorker),
    allowAddons: Boolean(bucket.allowAddons),
    allowWasi: Boolean(bucket.allowWasi),
    allowInspector: Boolean(bucket.allowInspector),
    env: normalizeEnv(bucket.env),
  };
}

function normalizeAllowNet(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }

  return Boolean(value);
}

function normalizePathList(value) {
  if (value === '*' || value === false) {
    return value;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => path.resolve(process.cwd(), entry));
}

function normalizeEnv(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = String(val);
  }
  return result;
}

function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input)));
}

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function stripTrailingCommas(input) {
  return input.replace(/,\s*([}\]])/g, '$1');
}

let cleanupHooksRegistered = false;

function registerCleanupHooks(runtimePool) {
  if (cleanupHooksRegistered) {
    return;
  }

  cleanupHooksRegistered = true;

  const closePool = () => {
    runtimePool.close();
  };

  process.once('exit', closePool);
  process.once('SIGINT', () => {
    closePool();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    closePool();
    process.exit(143);
  });
}

if (process.env.SANDBOXIFY_DISABLE !== '1') {
  installCjsRequireHook();
}
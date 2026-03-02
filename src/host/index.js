import fs from 'node:fs';

const moduleCache = new Map();

process.on('message', async (message) => {
  if (!message || message.t !== 'req') {
    return;
  }

  try {
    const value = await dispatch(message.op, message.p ?? {});
    process.send?.({ t: 'res', id: message.id, ok: true, v: value });
  } catch (error) {
    process.send?.({
      t: 'res',
      id: message.id,
      ok: false,
      e: serializeError(error),
    });
  }
});

async function dispatch(op, payload) {
  if (op === 'hello') {
    return {
      version: 1,
      nodeVersion: process.version,
      bucket: process.env.SANDBOXIFY_BUCKET ?? 'unknown',
      capabilities: {
        supportsLoad: true,
        supportsCall: true,
        supportsCallMany: true,
      },
    };
  }

  if (op === 'load') {
    return loadModule(payload);
  }

  if (op === 'call') {
    return callExport(payload);
  }

  if (op === 'callMany') {
    return callExportMany(payload);
  }

  throw new Error(`Unknown RPC operation: ${op}`);
}

async function loadModule({ moduleKey, url, exportNames }) {
  const key = moduleKey ?? url;
  const namespace = await getModuleNamespace(key, url);
  const names = Array.isArray(exportNames) && exportNames.length > 0 ? exportNames : Object.keys(namespace);
  const exports = {};

  for (const exportName of names) {
    if (!(exportName in namespace)) {
      continue;
    }

    exports[exportName] = describeExport(namespace[exportName]);
  }

  return {
    moduleKey: key,
    exportNames: names,
    exports,
  };
}

async function callExport({ moduleKey, exportName, args }) {
  const namespace = moduleCache.get(moduleKey);
  if (!namespace) {
    throw new Error(`Module not loaded: ${moduleKey}`);
  }

  const target = namespace[exportName];
  if (typeof target !== 'function') {
    throw new Error(`Export \"${exportName}\" is not callable`);
  }

  const resolvedArgs = decodeBlobReferences(Array.isArray(args) ? args : []);
  const result = await target(...resolvedArgs);
  if (!isCloneable(result)) {
    throw new Error(`Return value for export \"${exportName}\" is not structured-cloneable`);
  }

  return { result };
}

async function callExportMany({ moduleKey, exportName, argsList }) {
  const namespace = moduleCache.get(moduleKey);
  if (!namespace) {
    throw new Error(`Module not loaded: ${moduleKey}`);
  }

  const target = namespace[exportName];
  if (typeof target !== 'function') {
    throw new Error(`Export \"${exportName}\" is not callable`);
  }

  const calls = Array.isArray(argsList) ? argsList : [];
  const results = [];

  for (const entry of calls) {
    const resolvedArgs = decodeBlobReferences(Array.isArray(entry) ? entry : []);
    const value = await target(...resolvedArgs);
    if (!isCloneable(value)) {
      throw new Error(`Return value for export \"${exportName}\" is not structured-cloneable`);
    }
    results.push(value);
  }

  return { results };
}

async function getModuleNamespace(key, url) {
  if (moduleCache.has(key)) {
    return moduleCache.get(key);
  }

  const namespace = await import(url);
  moduleCache.set(key, namespace);
  return namespace;
}

function describeExport(value) {
  if (typeof value === 'function') {
    return { kind: 'function' };
  }

  if (isCloneable(value)) {
    return { kind: 'value', value };
  }

  return {
    kind: 'unsupported',
    valueType: value === null ? 'null' : typeof value,
  };
}

function isCloneable(value) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    data: error?.data,
  };
}

function decodeBlobReferences(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeBlobReferences(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value.__sandboxifyBlobRef === 1 && typeof value.file === 'string') {
    const content = fs.readFileSync(value.file);
    try {
      fs.unlinkSync(value.file);
    } catch {
      // noop
    }

    if (value.as === 'uint8array') {
      return new Uint8Array(content);
    }

    return content;
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = decodeBlobReferences(entry);
    }
    return out;
  }

  return value;
}

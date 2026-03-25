import fs from "node:fs";

const moduleCache = new Map();
const HELLO_RESPONSE = {
  version: 1,
  nodeVersion: process.version,
  bucket: process.env.SANDBOXIFY_BUCKET ?? "unknown",
  capabilities: {
    supportsLoad: true,
    supportsCall: true,
    supportsCallMany: true,
  },
};

process.on("message", (message) => {
  if (!message || message.t !== "req") {
    return;
  }

  try {
    sendRpcValue(message.id, dispatch(message.op, message.p ?? {}));
  } catch (error) {
    sendRpcError(message.id, error);
  }
});

function dispatch(op, payload) {
  if (op === "hello") {
    return HELLO_RESPONSE;
  }

  if (op === "load") {
    return loadModule(payload);
  }

  if (op === "call") {
    return callExport(payload);
  }

  if (op === "callMany") {
    return callExportMany(payload);
  }

  throw new Error(`Unknown RPC operation: ${op}`);
}

function loadModule({ moduleKey, url, exportNames }) {
  const key = moduleKey ?? url;
  const namespace = getModuleNamespace(key, url);

  if (isThenable(namespace)) {
    return namespace.then((resolvedNamespace) =>
      createLoadResponse(key, exportNames, resolvedNamespace),
    );
  }

  return createLoadResponse(key, exportNames, namespace);
}

function createLoadResponse(key, exportNames, namespace) {
  const names =
    Array.isArray(exportNames) && exportNames.length > 0
      ? exportNames
      : Object.keys(namespace);
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

function callExport({ moduleKey, exportName, args, hasBlobRefs = false }) {
  const namespace = getLoadedModuleNamespace(moduleKey);
  const target = namespace[exportName];
  if (typeof target !== "function") {
    throw new Error(`Export \"${exportName}\" is not callable`);
  }

  const rawArgs = Array.isArray(args) ? args : [];
  const resolvedArgs = hasBlobRefs ? decodeBlobReferences(rawArgs) : rawArgs;
  return wrapRpcResult(target(...resolvedArgs), (result) => ({ result }));
}

function callExportMany({
  moduleKey,
  exportName,
  argsList,
  hasBlobRefs = false,
  emptyArgsCount = null,
}) {
  const namespace = getLoadedModuleNamespace(moduleKey);
  const target = namespace[exportName];
  if (typeof target !== "function") {
    throw new Error(`Export \"${exportName}\" is not callable`);
  }

  if (Number.isInteger(emptyArgsCount) && emptyArgsCount >= 0) {
    return callExportManyEmpty(target, emptyArgsCount);
  }

  const calls = Array.isArray(argsList) ? argsList : [];
  const results = [];

  for (let index = 0; index < calls.length; index += 1) {
    const rawArgs = Array.isArray(calls[index]) ? calls[index] : [];
    const resolvedArgs = hasBlobRefs ? decodeBlobReferences(rawArgs) : rawArgs;
    const value = target(...resolvedArgs);
    if (isThenable(value)) {
      return finishCallExportManyAsync(
        target,
        calls,
        results,
        value,
        index,
        hasBlobRefs,
      );
    }
    results.push(value);
  }

  return packBatchResults(results);
}

function callExportManyEmpty(target, count) {
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const value = target();
    if (isThenable(value)) {
      return finishCallExportManyEmptyAsync(target, count, results, value, index);
    }
    results.push(value);
  }

  return packBatchResults(results);
}

async function finishCallExportManyAsync(
  target,
  calls,
  results,
  firstPending,
  startIndex,
  hasBlobRefs,
) {
  results.push(await firstPending);

  for (let index = startIndex + 1; index < calls.length; index += 1) {
    const rawArgs = Array.isArray(calls[index]) ? calls[index] : [];
    const resolvedArgs = hasBlobRefs ? decodeBlobReferences(rawArgs) : rawArgs;
    results.push(await target(...resolvedArgs));
  }

  return packBatchResults(results);
}

async function finishCallExportManyEmptyAsync(
  target,
  count,
  results,
  firstPending,
  startIndex,
) {
  results.push(await firstPending);

  for (let index = startIndex + 1; index < count; index += 1) {
    results.push(await target());
  }

  return packBatchResults(results);
}

function getModuleNamespace(key, url) {
  const cached = moduleCache.get(key);
  if (cached) {
    return cached;
  }

  const namespacePromise = import(url).then(
    (namespace) => {
      moduleCache.set(key, namespace);
      return namespace;
    },
    (error) => {
      moduleCache.delete(key);
      throw error;
    },
  );
  moduleCache.set(key, namespacePromise);
  return namespacePromise;
}

function getLoadedModuleNamespace(moduleKey) {
  const namespace = moduleCache.get(moduleKey);
  if (!namespace || isThenable(namespace)) {
    throw new Error(`Module not loaded: ${moduleKey}`);
  }

  return namespace;
}

function sendRpcValue(id, value) {
  if (isThenable(value)) {
    value.then(
      (resolvedValue) => {
        process.send?.({ t: "res", id, ok: true, v: resolvedValue });
      },
      (error) => {
        sendRpcError(id, error);
      },
    );
    return;
  }

  process.send?.({ t: "res", id, ok: true, v: value });
}

function sendRpcError(id, error) {
  process.send?.({
    t: "res",
    id,
    ok: false,
    e: serializeError(error),
  });
}

function wrapRpcResult(value, wrap) {
  if (isThenable(value)) {
    return value.then((resolvedValue) => wrap(resolvedValue));
  }

  return wrap(value);
}

function packBatchResults(results) {
  const repeated = encodeRepeatedResult(results);
  if (repeated) {
    return {
      repeatedResult: repeated,
    };
  }

  return { results };
}

function encodeRepeatedResult(results) {
  if (results.length < 2) {
    return null;
  }

  const first = results[0];
  if (!isRepeatableBatchValue(first)) {
    return null;
  }

  for (let index = 1; index < results.length; index += 1) {
    if (!Object.is(results[index], first)) {
      return null;
    }
  }

  return {
    count: results.length,
    value: first,
  };
}

function isRepeatableBatchValue(value) {
  return (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isThenable(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function describeExport(value) {
  if (typeof value === "function") {
    return { kind: "function" };
  }

  if (isCloneable(value)) {
    return { kind: "value", value };
  }

  return {
    kind: "unsupported",
    valueType: value === null ? "null" : typeof value,
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
    name: error?.name ?? "Error",
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

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value.__sandboxifyBlobRef === 1 && typeof value.file === "string") {
    const content = fs.readFileSync(value.file);
    try {
      fs.unlinkSync(value.file);
    } catch {
      // noop
    }

    if (value.as === "uint8array") {
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

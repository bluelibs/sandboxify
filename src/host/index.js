import fs from "node:fs";
import { registerHooks } from "node:module";
import { createSandboxHooks } from "../loader/index.js";
import { runWithLoadTrace } from "../runtime/index.js";
import {
  isEncodedClientReference,
  isEncodedHostReference,
} from "../runtime/reference.js";

const moduleCache = new Map();
const handleCache = new Map();
const handleIdsByValue = new WeakMap();
const pendingParentRequests = new Map();
let nextHandleId = 1;
let nextParentRequestId = 1;
const HELLO_RESPONSE = {
  version: 1,
  nodeVersion: process.version,
  bucket: process.env.SANDBOXIFY_BUCKET ?? "unknown",
  capabilities: {
    supportsLoad: true,
    supportsCall: true,
    supportsCallMany: true,
    supportsConstruct: true,
  },
};

registerSandboxHostHooks();

process.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.t === "res") {
    onParentResponse(message);
    return;
  }

  if (message.t !== "req") {
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

  if (op === "construct") {
    return constructExport(payload);
  }

  if (op === "handleGet") {
    return getHandleProperty(payload);
  }

  if (op === "handleCall") {
    return callHandleMember(payload);
  }

  if (op === "handleInvoke") {
    return invokeHandle(payload);
  }

  if (op === "instanceCall") {
    return callHandleMember(payload);
  }

  if (op === "releaseHandle") {
    return releaseHandle(payload);
  }

  if (op === "releaseInstance") {
    return releaseHandle(payload);
  }

  throw new Error(`Unknown RPC operation: ${op}`);
}

function loadModule({ moduleKey, url, exportNames, loadTrace = [] }) {
  const key = moduleKey ?? url;
  const namespace = runWithLoadTrace(loadTrace, () => getModuleNamespace(key, url));

  if (isThenable(namespace)) {
    return namespace.then((resolvedNamespace) =>
      createLoadResponse(key, exportNames, resolvedNamespace),
    );
  }

  return createLoadResponse(key, exportNames, namespace);
}

function registerSandboxHostHooks() {
  registerHooks(
    createSandboxHooks({
      policyPath:
        process.env.SANDBOXIFY_POLICY_PATH ?? "./sandboxify.policy.jsonc",
      manifestPath: process.env.SANDBOXIFY_MANIFEST_PATH,
      localBucket: process.env.SANDBOXIFY_BUCKET ?? null,
    }),
  );
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

  const resolvedArgs = decodeRpcArguments(args, hasBlobRefs);
  return wrapRpcResult(target(...resolvedArgs), (result) => ({
    result: encodeRpcValue(result),
  }));
}

function constructExport({ moduleKey, exportName, args, hasBlobRefs = false }) {
  const namespace = getLoadedModuleNamespace(moduleKey);
  const target = namespace[exportName];
  if (typeof target !== "function") {
    throw new Error(`Export \"${exportName}\" is not constructable`);
  }

  const resolvedArgs = decodeRpcArguments(args, hasBlobRefs);
  return wrapRpcResult(Reflect.construct(target, resolvedArgs), (instance) => ({
    ...createRpcResultPayload(encodeRpcValue(instance)),
  }));
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
    const resolvedArgs = decodeRpcArguments(calls[index], hasBlobRefs);
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
    const resolvedArgs = decodeRpcArguments(calls[index], hasBlobRefs);
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

function callInstanceMember(payload) {
  return callHandleMember(payload);
}

function callHandleMember({ handleId, instanceId, memberName, args, hasBlobRefs = false }) {
  const resolvedHandleId = handleId ?? instanceId;
  const targetObject = getLoadedHandle(resolvedHandleId);
  const target = targetObject?.[memberName];
  if (typeof target !== "function") {
    throw new Error(`Remote handle member \"${memberName}\" is not callable`);
  }

  const resolvedArgs = decodeRpcArguments(args, hasBlobRefs);
  return wrapRpcResult(target.apply(targetObject, resolvedArgs), (result) => ({
    ...createRpcResultPayload(encodeRpcValue(result)),
    ...createLegacyHandleSnapshot(targetObject),
  }));
}

function invokeHandle({ handleId, args, hasBlobRefs = false }) {
  const target = getLoadedHandle(handleId);
  if (typeof target !== "function") {
    throw new Error(`Remote handle \"${handleId}\" is not callable`);
  }

  const resolvedArgs = decodeRpcArguments(args, hasBlobRefs);
  return wrapRpcResult(target(...resolvedArgs), (result) => ({
    ...createRpcResultPayload(encodeRpcValue(result)),
    ...createLegacyHandleSnapshot(target),
  }));
}

function getHandleProperty({ handleId, path }) {
  return {
    result: encodeRpcValue(resolveHandleReference({ handleId, path })),
  };
}

function releaseHandle({ handleId, instanceId }) {
  const resolvedHandleId = handleId ?? instanceId;
  if (!Number.isInteger(resolvedHandleId) || resolvedHandleId < 1) {
    return { released: false };
  }

  return {
    released: handleCache.delete(resolvedHandleId),
  };
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

function getLoadedHandle(handleId) {
  const value = handleCache.get(handleId);
  if (!value) {
    throw new Error(`Remote handle not found: ${handleId}`);
  }

  return value;
}

function onParentResponse(message) {
  const pending = pendingParentRequests.get(message.id);
  if (!pending) {
    return;
  }

  pendingParentRequests.delete(message.id);

  if (message.ok) {
    pending.resolve(message.v);
    return;
  }

  pending.reject(deserializeError(message.e));
}

function requestParent(op, payload) {
  const id = nextParentRequestId++;
  return new Promise((resolve, reject) => {
    pendingParentRequests.set(id, { resolve, reject });
    process.send?.({ t: "req", id, op, p: payload }, (error) => {
      if (!error) {
        return;
      }

      pendingParentRequests.delete(id);
      reject(error);
    });
  });
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

function createRpcResultPayload(encodedResult) {
  if (
    encodedResult &&
    typeof encodedResult === "object" &&
    encodedResult.kind === "handle" &&
    Number.isInteger(encodedResult.handleId)
  ) {
    return {
      result: encodedResult,
      instanceId: encodedResult.handleId,
      methods: encodedResult.methods,
      state: encodedResult.state,
    };
  }

  return {
    result: encodedResult,
  };
}

function createLegacyHandleSnapshot(value) {
  const descriptor = createHandleDescriptor(value);
  return {
    handle: descriptor,
    state: descriptor.state,
  };
}

function packBatchResults(results) {
  const encodedResults = results.map((entry) => encodeRpcValue(entry));
  const repeated = encodeRepeatedResult(encodedResults);
  if (repeated) {
    return {
      repeatedResult: repeated,
    };
  }

  return { results: encodedResults };
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
    return {
      kind: "function",
      constructable: isConstructable(value),
    };
  }

  if (shouldEncodeAsHandle(value)) {
    return createHandleDescriptor(value);
  }

  if (isCloneable(value)) {
    return { kind: "value", value };
  }

  return {
    kind: "unsupported",
    valueType: value === null ? "null" : typeof value,
  };
}

function createHandleDescriptor(value) {
  const handleId = registerHandle(value);
  return {
    kind: "handle",
    handleId,
    callable: typeof value === "function",
    constructable: isConstructable(value),
    methods: collectHandleMethodNames(value),
    properties: collectHandlePropertyNames(value),
    state: captureHandleState(value),
  };
}

function registerHandle(value) {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) {
    throw new Error("Only objects and functions can be registered as handles");
  }

  const cachedHandleId = handleIdsByValue.get(value);
  if (Number.isInteger(cachedHandleId)) {
    handleCache.set(cachedHandleId, value);
    return cachedHandleId;
  }

  const handleId = nextHandleId++;
  handleIdsByValue.set(value, handleId);
  handleCache.set(handleId, value);
  return handleId;
}

function collectHandleMethodNames(value) {
  const names = new Set();
  collectDescriptorMethods(value, names);
  let current = Object.getPrototypeOf(value);

  while (current && current !== Object.prototype && current !== Function.prototype) {
    collectDescriptorMethods(current, names);
    current = Object.getPrototypeOf(current);
  }

  return [...names];
}

function collectDescriptorMethods(target, names) {
  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(target),
  )) {
    if (name === "constructor") {
      continue;
    }

    if (typeof descriptor.value === "function") {
      names.add(name);
    }
  }
}

function collectHandlePropertyNames(value) {
  const names = new Set();
  collectDescriptorProperties(value, names);
  let current = Object.getPrototypeOf(value);

  while (current && current !== Object.prototype && current !== Function.prototype) {
    collectDescriptorProperties(current, names);
    current = Object.getPrototypeOf(current);
  }

  return [...names];
}

function collectDescriptorProperties(target, names) {
  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(target),
  )) {
    if (name === "constructor") {
      continue;
    }

    if (typeof descriptor.value === "function") {
      continue;
    }

    names.add(name);
  }
}

function captureHandleState(value) {
  const state = {};

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!Object.hasOwn(descriptor, "value")) {
      continue;
    }

    if (typeof descriptor.value === "function") {
      continue;
    }

    const encodedValue = encodeRpcValue(descriptor.value);
    if (isUnsupportedEncodedValue(encodedValue)) {
      continue;
    }

    state[key] = encodedValue;
  }

  return state;
}

function isUnsupportedEncodedValue(value) {
  return Boolean(value) && typeof value === "object" && value.kind === "unsupported";
}

function isCloneable(value) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function isConstructable(value) {
  if (typeof value !== "function") {
    return false;
  }

  try {
    Reflect.construct(String, [], value);
    return true;
  } catch {
    return false;
  }
}

function shouldEncodeAsHandle(value) {
  if (value == null) {
    return false;
  }

  if (typeof value === "function") {
    return true;
  }

  if (typeof value !== "object" || isBuiltinCloneableObject(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return hasCallableOrAccessorOwnProperties(value);
  }

  return true;
}

function hasCallableOrAccessorOwnProperties(value) {
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (typeof descriptor.value === "function") {
      return true;
    }

    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      return true;
    }
  }

  return false;
}

function isBuiltinCloneableObject(value) {
  return (
    Array.isArray(value) ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof URL ||
    value instanceof Error
  );
}

function encodeRpcValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => encodeRpcValue(entry));
  }

  if (isPlainObject(value)) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = encodeRpcValue(entry);
    }
    return output;
  }

  if (shouldEncodeAsHandle(value)) {
    return createHandleDescriptor(value);
  }

  if (isCloneable(value)) {
    return value;
  }

  return {
    kind: "unsupported",
    valueType: value === null ? "null" : typeof value,
  };
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

function deserializeError(raw) {
  const error = new Error(raw?.message ?? "Sandbox callback error");
  error.name = raw?.name ?? "SandboxCallbackError";
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

function decodeRpcArguments(args, hasBlobRefs) {
  const rawArgs = Array.isArray(args) ? args : [];
  const prepared = hasBlobRefs ? decodeBlobReferences(rawArgs) : rawArgs;
  return prepared.map((entry) => decodeRpcValue(entry));
}

function decodeRpcValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeRpcValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (isEncodedHostReference(value)) {
    return resolveHandleReference(value);
  }

  if (isEncodedClientReference(value)) {
    return createClientHandleProxy(value);
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = decodeRpcValue(entry);
    }
    return output;
  }

  return value;
}

function resolveHandleReference(reference) {
  const path = Array.isArray(reference.path)
    ? reference.path.filter((entry) => typeof entry === "string")
    : [];
  let current = getLoadedHandle(reference.handleId);

  for (const propertyName of path) {
    current = current?.[propertyName];
  }

  return current;
}

function createClientHandleProxy(reference) {
  const compiled = compileClientFunction(reference);
  if (compiled) {
    return compiled;
  }

  return (...args) =>
    requestParent("clientHandleCall", {
      handleId: reference.handleId,
      args,
    }).then((response) => response?.result);
}

function compileClientFunction(reference) {
  if (typeof reference?.source !== "string" || reference.source.length === 0) {
    return null;
  }

  try {
    const fn = Function(`return (${reference.source})`)();
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
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

function isPlainObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

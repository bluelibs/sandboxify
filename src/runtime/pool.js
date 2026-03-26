import { RpcClient } from "./rpc-client.js";
import {
  appendHostReferencePath,
  HOST_REFERENCE_TAG,
  REMOTE_REFERENCE,
  getRemoteReference,
  isEncodedHostReference,
} from "./reference.js";

const remoteHandleRegistry =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry(({ client, handleId }) => {
        client.request("releaseHandle", { handleId }).catch(() => {});
      })
    : null;

export class RuntimePool {
  constructor(policy) {
    this.policy = policy;
    this.clients = new Map();
    this.namespaceCache = new Map();
  }

  async getRemoteModule({
    bucket,
    specifier,
    realUrl,
    exportNames,
    loadTrace = [],
  }) {
    const nextLoadTrace = appendBucketToLoadTrace(loadTrace, bucket);
    const cacheKey = `${bucket}::${realUrl}`;
    if (this.namespaceCache.has(cacheKey)) {
      return this.namespaceCache.get(cacheKey);
    }

    const namespacePromise = this.loadRemoteModule({
      bucket,
      specifier,
      realUrl,
      exportNames,
      loadTrace: nextLoadTrace,
    });
    this.namespaceCache.set(cacheKey, namespacePromise);
    return namespacePromise;
  }

  async loadRemoteModule({
    bucket,
    specifier,
    realUrl,
    exportNames,
    loadTrace = [],
  }) {
    const bucketPolicy = this.policy.buckets[bucket];
    if (!bucketPolicy) {
      throw new Error(`No bucket policy configured for ${bucket}`);
    }

    const client = this.getClient(bucket, bucketPolicy);

    debugLog("loadRemoteModule", {
      bucket,
      specifier,
      realUrl,
      exportNamesCount: exportNames?.length ?? 0,
      loadTrace,
      pid: client.proc?.pid,
    });

    const response = await client.request("load", {
      moduleKey: realUrl,
      specifier,
      url: realUrl,
      exportNames,
      loadTrace,
    });

    return createNamespaceProxy(
      client,
      realUrl,
      response.exports ?? {},
      exportNames,
    );
  }

  getClient(bucketName, bucketPolicy) {
    if (this.clients.has(bucketName)) {
      return this.clients.get(bucketName);
    }

    const client = new RpcClient(bucketName, bucketPolicy);
    this.clients.set(bucketName, client);
    return client;
  }

  close() {
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.namespaceCache.clear();
  }
}

function appendBucketToLoadTrace(loadTrace, bucket) {
  const normalized = Array.isArray(loadTrace)
    ? loadTrace.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];

  if (normalized.includes(bucket)) {
    const cycle = [...normalized, bucket].join(" -> ");
    throw new Error(`Cross-bucket circular import detected: ${cycle}`);
  }

  return [...normalized, bucket];
}

function createNamespaceProxy(client, moduleKey, descriptors, exportNames) {
  const namespace = {};

  for (const exportName of exportNames) {
    const descriptor = descriptors[exportName];

    if (!descriptor) {
      namespace[exportName] = undefined;
      continue;
    }

    if (descriptor.kind === "function") {
      namespace[exportName] = createCallableExportProxy(
        client,
        moduleKey,
        exportName,
        descriptor,
      );
      continue;
    }

    if (descriptor.kind === "value") {
      namespace[exportName] = materializeRpcValue(client, descriptor.value);
      continue;
    }

    if (descriptor.kind === "handle") {
      namespace[exportName] = materializeRpcValue(client, descriptor);
      continue;
    }

    namespace[exportName] = () => {
      throw new Error(
        `Unsupported export shape for \"${exportName}\". Export type: ${descriptor.valueType ?? "unknown"}`,
      );
    };
  }

  return namespace;
}

function createCallableExportProxy(client, moduleKey, exportName, descriptor) {
  const target = function sandboxifyRemoteCallable() {};

  const callSingle = (...args) =>
    createRemoteResultProxy(
      client,
      client
        .request("call", {
          moduleKey,
          exportName,
          ...(args.length > 0 ? { args } : {}),
        })
        .then((response) =>
          materializeRpcValue(client, response?.result ?? response),
        ),
    );

  const batch = (argsList) => {
    const payload = {
      moduleKey,
      exportName,
    };
    const normalizedArgsList = Array.isArray(argsList) ? argsList : [];

    if (normalizedArgsList.length > 0) {
      if (allCallsUseEmptyArgs(normalizedArgsList)) {
        payload.emptyArgsCount = normalizedArgsList.length;
      } else {
        payload.argsList = normalizedArgsList;
      }
    }

    return client
      .request("callMany", payload)
      .then((response) => decodeBatchResults(client, response));
  };

  const construct = (...args) => {
    if (!descriptor.constructable) {
      throw new TypeError(`${exportName} is not a constructor`);
    }

    return createRemoteResultProxy(
      client,
      client
        .request("construct", {
          moduleKey,
          exportName,
          ...(args.length > 0 ? { args } : {}),
        })
        .then((response) =>
          materializeRpcValue(client, response?.result ?? response),
        ),
    );
  };

  return new Proxy(target, {
    apply(_target, _thisArg, args) {
      return callSingle(...args);
    },
    construct(_target, args) {
      return construct(...args);
    },
    get(_target, prop, receiver) {
      if (prop === "batch") {
        return batch;
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function materializeRpcValue(client, value) {
  if (Array.isArray(value)) {
    return value.map((entry) => materializeRpcValue(client, entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value.kind === "handle" && Number.isInteger(value.handleId)) {
    return createRemoteHandleProxy(client, value);
  }

  if (Number.isInteger(value.instanceId)) {
    return createRemoteHandleProxy(client, {
      kind: "handle",
      handleId: value.instanceId,
      callable: false,
      constructable: false,
      legacyInstanceOps: true,
      methods: Array.isArray(value.methods) ? value.methods : [],
      properties:
        value.state && typeof value.state === "object"
          ? Object.keys(value.state)
          : [],
      state: value.state,
    });
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = materializeRpcValue(client, entry);
    }
    return out;
  }

  return value;
}

function createRemoteHandleProxy(client, descriptor) {
  ensureClientHandleCache(client);
  const handleId = descriptor.handleId;
  const cachedState = client.remoteHandleCache.get(handleId);
  if (cachedState) {
    syncRemoteHandleState(cachedState, descriptor);
    return cachedState.proxy;
  }

  const target = descriptor.callable
    ? function sandboxifyRemoteHandle() {}
    : Object.create(null);
  const state = {
    client,
    handleId,
    callable: Boolean(descriptor.callable),
    constructable: Boolean(descriptor.constructable),
    methodNames: new Set(),
    propertyNames: new Set(),
    values: {},
    methodCache: new Map(),
    propertyCache: new Map(),
    operationQueue: Promise.resolve(),
    legacyInstanceOps: Boolean(descriptor.legacyInstanceOps),
    proxy: null,
  };

  syncRemoteHandleState(state, descriptor);

  const proxy = new Proxy(target, {
    apply(_target, _thisArg, args) {
      if (!state.callable) {
        throw new TypeError("Remote handle is not callable");
      }

      return invokeRemoteHandle(state, args);
    },
    construct() {
      if (!state.constructable) {
        throw new TypeError("Remote handle is not constructable");
      }

      throw new TypeError(
        "Constructing callable handles returned from remote methods is not supported yet",
      );
    },
    get(_target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }

      if (prop === REMOTE_REFERENCE) {
        return createRemoteReference(client, async () => ({
          [HOST_REFERENCE_TAG]: 1,
          handleId: state.handleId,
          path: [],
        }));
      }

      if (prop === "__sandboxifyRemoteHandleId") {
        return state.handleId;
      }

      if (prop === "__sandboxifyRemoteInstanceId") {
        return state.handleId;
      }

      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      if (Object.hasOwn(state.values, prop)) {
        return state.values[prop];
      }

      if (state.methodNames.has(prop)) {
        return getOrCreateRemoteHandleMethod(state, prop);
      }

      if (state.propertyNames.has(prop)) {
        return getOrCreateRemoteHandleProperty(state, prop);
      }

      return Reflect.get(target, prop, receiver);
    },
    has(_target, prop) {
      return (
        (typeof prop === "string" &&
          (state.methodNames.has(prop) ||
            state.propertyNames.has(prop) ||
            Object.hasOwn(state.values, prop))) ||
        Reflect.has(target, prop)
      );
    },
    ownKeys() {
      return [
        ...new Set([
          ...state.methodNames,
          ...state.propertyNames,
          ...Object.keys(state.values),
        ]),
      ];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }

      if (state.methodNames.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: getOrCreateRemoteHandleMethod(state, prop),
        };
      }

      if (Object.hasOwn(state.values, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: state.values[prop],
        };
      }

      if (state.propertyNames.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: getOrCreateRemoteHandleProperty(state, prop),
        };
      }

      return undefined;
    },
    set(_target, prop) {
      throw new Error(
        `Remote handle properties are read-only${typeof prop === "string" ? `: ${prop}` : ""}`,
      );
    },
  });

  state.proxy = proxy;
  client.remoteHandleCache.set(handleId, state);
  remoteHandleRegistry?.register(proxy, { client, handleId });
  return proxy;
}

function ensureClientHandleCache(client) {
  if (!client.remoteHandleCache) {
    client.remoteHandleCache = new Map();
  }
}

function syncRemoteHandleState(state, descriptor) {
  state.callable = Boolean(descriptor?.callable);
  state.constructable = Boolean(descriptor?.constructable);
  state.legacyInstanceOps = Boolean(descriptor?.legacyInstanceOps);
  state.methodNames = new Set(
    Array.isArray(descriptor?.methods)
      ? descriptor.methods.filter((entry) => typeof entry === "string")
      : [],
  );
  state.propertyNames = new Set(
    Array.isArray(descriptor?.properties)
      ? descriptor.properties.filter((entry) => typeof entry === "string")
      : [],
  );

  const nextValues = normalizeRemoteState(state.client, descriptor?.state);
  for (const key of Object.keys(state.values)) {
    if (!Object.hasOwn(nextValues, key)) {
      delete state.values[key];
    }
  }

  Object.assign(state.values, nextValues);
  for (const key of Object.keys(nextValues)) {
    state.propertyNames.add(key);
  }
}

function normalizeRemoteState(client, rawState) {
  if (!rawState || typeof rawState !== "object") {
    return {};
  }

  const output = {};
  for (const [key, value] of Object.entries(rawState)) {
    output[key] = materializeRpcValue(client, value);
  }
  return output;
}

function syncLegacyRemoteHandleState(state, rawState) {
  const nextValues = normalizeRemoteState(state.client, rawState);

  for (const key of Object.keys(state.values)) {
    if (!Object.hasOwn(nextValues, key)) {
      delete state.values[key];
      state.propertyNames.delete(key);
    }
  }

  Object.assign(state.values, nextValues);
  for (const key of Object.keys(nextValues)) {
    state.propertyNames.add(key);
  }
}

function getOrCreateRemoteHandleMethod(state, memberName) {
  if (state.methodCache.has(memberName)) {
    return state.methodCache.get(memberName);
  }

  const method = (...args) =>
    createRemoteResultProxy(
      state.client,
      enqueueHandleOperation(state, async () => {
        const response = await state.client.request(
          state.legacyInstanceOps ? "instanceCall" : "handleCall",
          state.legacyInstanceOps
            ? {
                instanceId: state.handleId,
                memberName,
                ...(args.length > 0 ? { args } : {}),
              }
            : {
                handleId: state.handleId,
                memberName,
                ...(args.length > 0 ? { args } : {}),
              },
        );

        if (response?.handle?.kind === "handle") {
          syncRemoteHandleState(state, response.handle);
        } else if (Object.hasOwn(response ?? {}, "state")) {
          syncLegacyRemoteHandleState(state, response?.state);
        }

        return materializeRpcValue(state.client, response?.result);
      }),
    );

  state.methodCache.set(memberName, method);
  return method;
}

function getOrCreateRemoteHandleProperty(state, propertyName) {
  if (state.propertyCache.has(propertyName)) {
    return state.propertyCache.get(propertyName);
  }

  const propertyProxy = createDeferredValueProxy(
    state.client,
    async () => {
      if (Object.hasOwn(state.values, propertyName)) {
        return state.values[propertyName];
      }

      const response = await enqueueHandleOperation(state, () =>
        state.client.request("handleGet", {
          handleId: state.handleId,
          path: [propertyName],
        }),
      );

      return materializeRpcValue(state.client, response?.result);
    },
    async () => ({
      [HOST_REFERENCE_TAG]: 1,
      handleId: state.handleId,
      path: [propertyName],
    }),
  );

  state.propertyCache.set(propertyName, propertyProxy);
  return propertyProxy;
}

function invokeRemoteHandle(state, args) {
  return createRemoteResultProxy(
    state.client,
    enqueueHandleOperation(state, async () => {
      const response = await state.client.request("handleInvoke", {
        handleId: state.handleId,
        ...(args.length > 0 ? { args } : {}),
      });

      if (response?.handle?.kind === "handle") {
        syncRemoteHandleState(state, response.handle);
      } else if (Object.hasOwn(response ?? {}, "state")) {
        syncLegacyRemoteHandleState(state, response?.state);
      }

      return materializeRpcValue(state.client, response?.result);
    }),
  );
}

function enqueueHandleOperation(state, run) {
  const work = state.operationQueue.then(() => run());
  state.operationQueue = work.catch(() => {});
  return work;
}

function createRemoteResultProxy(client, promise) {
  return createDeferredValueProxy(
    client,
    () => promise,
    async () => {
      const resolved = await promise;
      const reference = getRemoteReference(resolved);
      return reference ? reference.serialize() : resolved;
    },
  );
}

function createDeferredValueProxy(client, resolve, serialize = null) {
  let promise = null;
  const getPromise = () => {
    if (!promise) {
      promise = Promise.resolve().then(resolve);
    }
    return promise;
  };

  const target = function sandboxifyRemoteDeferred() {};

  return new Proxy(target, {
    apply(_target, _thisArg, args) {
      return createRemoteResultProxy(
        client,
        getPromise().then((resolved) => {
          if (typeof resolved !== "function") {
            throw new TypeError("Deferred remote value is not callable");
          }

          return resolved(...args);
        }),
      );
    },
    get(_target, prop, receiver) {
      if (prop === REMOTE_REFERENCE) {
        if (!serialize) {
          return null;
        }

        return createRemoteReference(client, serialize);
      }

      if (prop === "then") {
        return getPromise().then.bind(getPromise());
      }

      if (prop === "catch") {
        return getPromise().catch.bind(getPromise());
      }

      if (prop === "finally") {
        return getPromise().finally.bind(getPromise());
      }

      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      return createDeferredValueProxy(
        client,
        async () => {
          const resolved = await getPromise();
          return resolved?.[prop];
        },
        serialize
          ? async () => {
              const encoded = await serialize();
              if (isEncodedHostReference(encoded)) {
                return appendHostReferencePath(encoded, prop);
              }

              const resolved = await getPromise();
              return resolved?.[prop];
            }
          : null,
      );
    },
  });
}

function createRemoteReference(client, serialize) {
  return {
    client,
    serialize,
  };
}

function allCallsUseEmptyArgs(argsList) {
  for (const entry of argsList) {
    if (!Array.isArray(entry) || entry.length > 0) {
      return false;
    }
  }

  return true;
}

function decodeBatchResults(client, response) {
  if (Array.isArray(response?.results)) {
    return response.results.map((entry) => materializeRpcValue(client, entry));
  }

  const repeated = response?.repeatedResult;
  if (
    !repeated ||
    !Number.isInteger(repeated.count) ||
    repeated.count < 0
  ) {
    return [];
  }

  const value = materializeRpcValue(client, repeated.value);
  return Array.from({ length: repeated.count }, () => value);
}

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== "1") {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.error(`[sandboxify][runtime] ${event}${payload}`);
}

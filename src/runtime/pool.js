import { RpcClient } from "./rpc-client.js";

const remoteInstanceRegistry =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry(({ client, instanceId }) => {
        client.request("releaseInstance", { instanceId }).catch(() => {});
      })
    : null;

export class RuntimePool {
  constructor(policy) {
    this.policy = policy;
    this.clients = new Map();
    this.namespaceCache = new Map();
  }

  async getRemoteModule({ bucket, specifier, realUrl, exportNames }) {
    const cacheKey = `${bucket}::${realUrl}`;
    if (this.namespaceCache.has(cacheKey)) {
      return this.namespaceCache.get(cacheKey);
    }

    const namespacePromise = this.loadRemoteModule({
      bucket,
      specifier,
      realUrl,
      exportNames,
    });
    this.namespaceCache.set(cacheKey, namespacePromise);
    return namespacePromise;
  }

  async loadRemoteModule({ bucket, specifier, realUrl, exportNames }) {
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
      pid: client.proc?.pid,
    });

    const response = await client.request("load", {
      moduleKey: realUrl,
      specifier,
      url: realUrl,
      exportNames,
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
      namespace[exportName] = descriptor.value;
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

  const callSingle = (...args) => {
    const payload = {
      moduleKey,
      exportName,
    };
    if (args.length > 0) {
      payload.args = args;
    }

    return client.request("call", payload).then((response) => response?.result);
  };

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
      .then((response) => decodeBatchResults(response));
  };

  const construct = (...args) => {
    if (!descriptor.constructable) {
      throw new TypeError(`${exportName} is not a constructor`);
    }

    const payload = {
      moduleKey,
      exportName,
    };
    if (args.length > 0) {
      payload.args = args;
    }

    return client
      .request("construct", payload)
      .then((response) => createRemoteInstanceProxy(client, response));
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

function createRemoteInstanceProxy(client, response) {
  const instanceId = response?.instanceId;
  const state = normalizeRemoteState(response?.state);
  const methodNames = new Set(
    Array.isArray(response?.methods)
      ? response.methods.filter((entry) => typeof entry === "string")
      : [],
  );
  const methodCache = new Map();
  const target = Object.create(null);

  const proxy = new Proxy(target, {
    get(_target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }

      if (prop === "__sandboxifyRemoteInstanceId") {
        return instanceId;
      }

      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      if (methodNames.has(prop)) {
        if (methodCache.has(prop)) {
          return methodCache.get(prop);
        }

        const method = (...args) =>
          client
            .request("instanceCall", {
              instanceId,
              memberName: prop,
              args,
            })
            .then((methodResponse) => {
              syncRemoteState(state, methodResponse?.state);
              return methodResponse?.result;
            });

        methodCache.set(prop, method);
        return method;
      }

      if (Object.hasOwn(state, prop)) {
        return state[prop];
      }

      return Reflect.get(target, prop, receiver);
    },
    has(_target, prop) {
      return (
        (typeof prop === "string" &&
          (methodNames.has(prop) || Object.hasOwn(state, prop))) ||
        Reflect.has(target, prop)
      );
    },
    ownKeys() {
      return [...new Set([...methodNames, ...Object.keys(state)])];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && methodNames.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: methodCache.get(prop) ?? undefined,
        };
      }

      if (typeof prop === "string" && Object.hasOwn(state, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: state[prop],
        };
      }

      return undefined;
    },
    set(_target, prop) {
      throw new Error(
        `Remote instance properties are read-only${typeof prop === "string" ? `: ${prop}` : ""}`,
      );
    },
  });

  remoteInstanceRegistry?.register(proxy, { client, instanceId });
  return proxy;
}

function normalizeRemoteState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    return {};
  }

  return { ...rawState };
}

function syncRemoteState(targetState, nextState) {
  const normalizedState = normalizeRemoteState(nextState);

  for (const key of Object.keys(targetState)) {
    if (!Object.hasOwn(normalizedState, key)) {
      delete targetState[key];
    }
  }

  Object.assign(targetState, normalizedState);
}

function allCallsUseEmptyArgs(argsList) {
  for (const entry of argsList) {
    if (!Array.isArray(entry) || entry.length > 0) {
      return false;
    }
  }

  return true;
}

function decodeBatchResults(response) {
  if (Array.isArray(response?.results)) {
    return response.results;
  }

  const repeated = response?.repeatedResult;
  if (
    !repeated ||
    !Number.isInteger(repeated.count) ||
    repeated.count < 0
  ) {
    return [];
  }

  return Array.from({ length: repeated.count }, () => repeated.value);
}

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== "1") {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.error(`[sandboxify][runtime] ${event}${payload}`);
}

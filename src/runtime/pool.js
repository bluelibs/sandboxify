import { RpcClient } from './rpc-client.js';

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

    const namespacePromise = this.loadRemoteModule({ bucket, specifier, realUrl, exportNames });
    this.namespaceCache.set(cacheKey, namespacePromise);
    return namespacePromise;
  }

  async loadRemoteModule({ bucket, specifier, realUrl, exportNames }) {
    const bucketPolicy = this.policy.buckets[bucket];
    if (!bucketPolicy) {
      throw new Error(`No bucket policy configured for ${bucket}`);
    }

    const client = this.getClient(bucket, bucketPolicy);
    await client.ensureHello();

    debugLog('loadRemoteModule', { bucket, specifier, realUrl, exportNamesCount: exportNames?.length ?? 0, pid: client.proc?.pid });

    const response = await client.request('load', {
      moduleKey: realUrl,
      specifier,
      url: realUrl,
      exportNames,
    });

    return createNamespaceProxy(client, realUrl, response.exports ?? {}, exportNames);
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

    if (descriptor.kind === 'function') {
      const callSingle = (...args) =>
        client.request('call', {
          moduleKey,
          exportName,
          args,
        }).then((response) => response?.result);

      callSingle.batch = (argsList) =>
        client.request('callMany', {
          moduleKey,
          exportName,
          argsList: Array.isArray(argsList) ? argsList : [],
        }).then((response) => response?.results ?? []);

      namespace[exportName] = callSingle;
      continue;
    }

    if (descriptor.kind === 'value') {
      namespace[exportName] = descriptor.value;
      continue;
    }

    namespace[exportName] = () => {
      throw new Error(`Unsupported export shape for \"${exportName}\". Export type: ${descriptor.valueType ?? 'unknown'}`);
    };
  }

  return namespace;
}

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== '1') {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.error(`[sandboxify][runtime] ${event}${payload}`);
}

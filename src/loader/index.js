import crypto from "node:crypto";
import { createPolicyMatcher, loadPolicySync } from "../policy/index.js";
import { getManifestEntry, readManifestSync } from "../manifest/index.js";

const RUNTIME_MODULE_URL = new URL("../runtime/index.js", import.meta.url).href;

export function createSandboxHooks({
  policyPath = "./sandboxify.policy.jsonc",
  manifestPath = "./.sandboxify/exports.manifest.json",
} = {}) {
  if (process.env.SANDBOXIFY_DISABLE === "1") {
    return {
      resolve(specifier, context, nextResolve) {
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        return nextLoad(url, context);
      },
    };
  }

  const policy = loadPolicySync(policyPath);
  const matcher = createPolicyMatcher(policy);
  const manifest = readManifestSafe(manifestPath);
  const recordsByUrl = new Map();
  const sandboxUrlByRecordKey = new Map();
  const exportNamesByModuleKey = new Map();

  return {
    resolve(specifier, context, nextResolve) {
      const bucket = matcher.match(specifier, context.parentURL ?? "");
      if (!bucket) {
        return nextResolve(specifier, context);
      }

      const resolved = nextResolve(specifier, context);
      const recordKey = `${bucket}\u0000${specifier}\u0000${resolved.url}`;
      let sandboxUrl = sandboxUrlByRecordKey.get(recordKey);

      if (!sandboxUrl) {
        const id = hashRecord(bucket, specifier, resolved.url);
        const exportNames = getExportNames(
          exportNamesByModuleKey,
          manifest,
          resolved.url,
          specifier,
        );
        sandboxUrl = `sandboxify:${encodeURIComponent(bucket)}:${id}`;
        sandboxUrlByRecordKey.set(recordKey, sandboxUrl);
        recordsByUrl.set(sandboxUrl, {
          bucket,
          specifier,
          realUrl: resolved.url,
          exportNames,
          source: generateStubSource({
            bucket,
            specifier,
            realUrl: resolved.url,
            exportNames,
          }),
        });
      }

      debugLog("resolve", { specifier, bucket, realUrl: resolved.url, url: sandboxUrl });

      return {
        shortCircuit: true,
        url: sandboxUrl,
      };
    },

    load(url, context, nextLoad) {
      if (!url.startsWith("sandboxify:")) {
        return nextLoad(url, context);
      }

      const record = recordsByUrl.get(url);

      if (!record) {
        throw new Error(`Sandbox record not found for URL: ${url}`);
      }

      debugLog("load", {
        bucket: record.bucket,
        specifier: record.specifier,
        realUrl: record.realUrl,
        exportNames: record.exportNames,
      });

      return {
        format: "module",
        shortCircuit: true,
        source: record.source,
      };
    },
  };
}

function readManifestSafe(manifestPath) {
  try {
    return readManifestSync(manifestPath);
  } catch {
    return {
      entriesByUrl: {},
      entriesBySpecifier: {},
    };
  }
}

function normalizeExportNames(exportNames) {
  if (!Array.isArray(exportNames) || exportNames.length === 0) {
    return ["default"];
  }

  const unique = [];
  const seen = new Set();

  for (const exportName of exportNames) {
    if (typeof exportName !== "string") {
      continue;
    }

    if (seen.has(exportName)) {
      continue;
    }

    seen.add(exportName);
    unique.push(exportName);
  }

  if (!seen.has("default")) {
    unique.unshift("default");
  }

  return unique;
}

function getExportNames(cache, manifest, realUrl, specifier) {
  const key = `${realUrl}\u0000${specifier}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const manifestEntry = getManifestEntry(manifest, realUrl, specifier);
  const exportNames = normalizeExportNames(manifestEntry?.exportNames);
  cache.set(key, exportNames);
  return exportNames;
}

function generateStubSource({ bucket, specifier, realUrl, exportNames }) {
  const namedExports = exportNames.filter(
    (exportName) => exportName !== "default" && isValidIdentifier(exportName),
  );
  const hasDefaultExport = exportNames.includes("default");
  const requestPayload = JSON.stringify({
    bucket,
    specifier,
    realUrl,
    exportNames,
  });

  const lines = [
    `import { getRemoteModule as __sandboxifyGetRemoteModule } from ${JSON.stringify(RUNTIME_MODULE_URL)};`,
    `const __sandboxifyModule = await __sandboxifyGetRemoteModule(${requestPayload});`,
  ];

  if (hasDefaultExport) {
    lines.push("export default __sandboxifyModule.default;");
  }

  for (const exportName of namedExports) {
    lines.push(
      `export const ${exportName} = __sandboxifyModule[${JSON.stringify(exportName)}];`,
    );
  }

  if (!hasDefaultExport && namedExports.length === 0) {
    lines.push("export {};");
  }

  return `${lines.join("\n")}\n`;
}

function hashRecord(bucket, specifier, realUrl) {
  return crypto
    .createHash("sha256")
    .update(bucket)
    .update("\u0000")
    .update(specifier)
    .update("\u0000")
    .update(realUrl)
    .digest("hex")
    .slice(0, 16);
}

function isValidIdentifier(value) {
  return /^[$A-Z_a-z][$\w]*$/.test(value);
}

function debugLog(event, data) {
  if (process.env.SANDBOXIFY_DEBUG !== "1") {
    return;
  }

  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.error(`[sandboxify][loader] ${event}${payload}`);
}

import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "./jsonc.js";

export function loadPolicySync(policyPath = "./sandboxify.policy.jsonc") {
  const absolutePath = path.resolve(process.cwd(), policyPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = parseJsonc(raw);
  return normalizePolicy(parsed, absolutePath);
}

export function normalizePolicy(policy, sourcePath = "") {
  const buckets = {};
  const inputBuckets = policy?.buckets ?? {};

  for (const [bucketName, bucketValue] of Object.entries(inputBuckets)) {
    buckets[bucketName] = normalizeBucket(bucketValue);
  }

  const packageMappings = [];
  const inputPackages = policy?.packages ?? {};
  const importerRules = [];

  for (const [pattern, bucketName] of Object.entries(inputPackages)) {
    if (!buckets[bucketName]) {
      throw new Error(
        `Policy references unknown bucket \"${bucketName}\" for pattern \"${pattern}\" (${sourcePath || "unknown source"})`,
      );
    }

    if (pattern.endsWith("*")) {
      packageMappings.push({
        type: "wildcard",
        pattern,
        prefix: pattern.slice(0, -1),
        bucket: bucketName,
      });
    } else {
      packageMappings.push({ type: "exact", pattern, bucket: bucketName });
    }
  }

  packageMappings.sort((a, b) => {
    if (a.type === "exact" && b.type !== "exact") return -1;
    if (a.type !== "exact" && b.type === "exact") return 1;
    if (a.type === "wildcard" && b.type === "wildcard") {
      return b.prefix.length - a.prefix.length;
    }
    return 0;
  });

  const inputImporterRules = Array.isArray(policy?.importerRules)
    ? policy.importerRules
    : [];
  for (const rule of inputImporterRules) {
    if (!rule || typeof rule !== "object") {
      continue;
    }

    const bucketName = rule.bucket;
    if (!buckets[bucketName]) {
      throw new Error(
        `Policy importerRules references unknown bucket "${bucketName}" (${sourcePath || "unknown source"})`,
      );
    }

    const importerPattern =
      typeof rule.importer === "string" ? rule.importer : "*";
    const specifierPattern =
      typeof rule.specifier === "string" ? rule.specifier : "*";

    importerRules.push(
      normalizeImporterRule({
        importerPattern,
        specifierPattern,
        bucket: bucketName,
      }),
    );
  }

  importerRules.sort(compareImporterRules);

  return {
    buckets,
    packageMappings,
    importerRules,
    sourcePath,
  };
}

export function createPolicyMatcher(policy) {
  const exact = new Map();
  const wildcard = [];
  const importerRules = Array.isArray(policy.importerRules)
    ? policy.importerRules
    : [];
  const cache = new Map();

  for (const mapping of policy.packageMappings ?? []) {
    if (mapping.type === "exact") {
      exact.set(mapping.pattern, mapping.bucket);
    } else {
      wildcard.push(mapping);
    }
  }

  wildcard.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    match(specifier, parentUrl = "") {
      const cacheKey = `${parentUrl}\u0000${specifier}`;
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      let bucket = null;

      if (importerRules.length > 0) {
        for (const rule of importerRules) {
          if (!patternMatches(rule.specifierMatcher, specifier)) {
            continue;
          }

          if (!patternMatches(rule.importerMatcher, parentUrl || "")) {
            continue;
          }

          bucket = rule.bucket;
          cache.set(cacheKey, bucket);
          return bucket;
        }
      }

      if (exact.has(specifier)) {
        bucket = exact.get(specifier);
        cache.set(cacheKey, bucket);
        return bucket;
      }

      for (const mapping of wildcard) {
        if (specifier.startsWith(mapping.prefix)) {
          bucket = mapping.bucket;
          cache.set(cacheKey, bucket);
          return bucket;
        }
      }

      cache.set(cacheKey, null);
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
    return a.specifierMatcher.type === "exact" ? -1 : 1;
  }

  if (a.specifierMatcher.anchorLength !== b.specifierMatcher.anchorLength) {
    return b.specifierMatcher.anchorLength - a.specifierMatcher.anchorLength;
  }

  if (a.importerMatcher.type !== b.importerMatcher.type) {
    return a.importerMatcher.type === "exact" ? -1 : 1;
  }

  return b.importerMatcher.anchorLength - a.importerMatcher.anchorLength;
}

function toPatternMatcher(pattern) {
  if (pattern === "*") {
    return { type: "any", anchorLength: 0, anchor: "" };
  }

  if (pattern.endsWith("*")) {
    const anchor = pattern.slice(0, -1);
    return { type: "prefix", anchorLength: anchor.length, anchor };
  }

  return { type: "exact", anchorLength: pattern.length, anchor: pattern };
}

function patternMatches(matcher, value) {
  if (matcher.type === "any") {
    return true;
  }

  if (matcher.type === "prefix") {
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
    limits: bucket.limits ?? {},
  };
}

function normalizeAllowNet(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }

  return Boolean(value);
}

function normalizePathList(value) {
  if (value === "*" || value === false) {
    return value;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => path.resolve(process.cwd(), entry));
}

function normalizeEnv(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = String(val);
  }
  return result;
}

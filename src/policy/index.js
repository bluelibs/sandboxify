import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
        matcher: toPatternMatcher(pattern),
        resolvedPattern: resolvePolicySpecifierPattern(pattern),
        resolvedMatcher: toResolvedPatternMatcher(pattern),
        bucket: bucketName,
      });
    } else {
      packageMappings.push({
        type: "exact",
        pattern,
        matcher: toPatternMatcher(pattern),
        packageSubpathPrefix: getPackageSubpathPrefix(pattern),
        packageSubpathMatcher: toPackageSubpathMatcher(pattern),
        resolvedPattern: resolvePolicySpecifierPattern(pattern),
        resolvedMatcher: toResolvedPatternMatcher(pattern),
        bucket: bucketName,
      });
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

  assertCanonicalPackageOwnership(packageMappings, importerRules, sourcePath);
  importerRules.sort(compareImporterRules);

  return {
    buckets,
    packageMappings,
    importerRules,
    sourcePath,
  };
}

export function createPolicyMatcher(policy) {
  const rawExact = new Map();
  const rawExactPackageSubpaths = [];
  const rawWildcard = [];
  const resolvedExact = new Map();
  const resolvedWildcard = [];
  const rawImporterRules = [];
  const resolvedImporterRules = [];

  for (const mapping of policy.packageMappings ?? []) {
    if (mapping.type === "exact") {
      rawExact.set(mapping.pattern, mapping.bucket);
      if (mapping.packageSubpathPrefix) {
        rawExactPackageSubpaths.push(mapping);
      }
      if (typeof mapping.resolvedPattern === "string") {
        resolvedExact.set(mapping.resolvedPattern, mapping.bucket);
      }
      continue;
    }

    rawWildcard.push(mapping);
    if (typeof mapping.resolvedPattern === "string") {
      resolvedWildcard.push({
        type: mapping.type,
        prefix: mapping.resolvedPattern.slice(0, -1),
        pattern: mapping.resolvedPattern,
        bucket: mapping.bucket,
      });
    }
  }

  for (const rule of Array.isArray(policy.importerRules) ? policy.importerRules : []) {
    rawImporterRules.push(rule);
    if (rule.resolvedSpecifierMatcher) {
      resolvedImporterRules.push(rule);
    }
  }

  rawExactPackageSubpaths.sort(
    (a, b) => b.packageSubpathPrefix.length - a.packageSubpathPrefix.length,
  );
  rawWildcard.sort((a, b) => b.prefix.length - a.prefix.length);
  resolvedWildcard.sort((a, b) => b.prefix.length - a.prefix.length);
  resolvedImporterRules.sort(compareResolvedImporterRules);

  const matchRaw = createMatchFn({
    exact: rawExact,
    exactPackageSubpaths: rawExactPackageSubpaths,
    wildcard: rawWildcard,
    importerRules: rawImporterRules,
    cache: new Map(),
    getRuleMatcher: (rule) => rule.specifierMatcher,
  });
  const matchResolved = createMatchFn({
    exact: resolvedExact,
    exactPackageSubpaths: [],
    wildcard: resolvedWildcard,
    importerRules: resolvedImporterRules,
    cache: new Map(),
    getRuleMatcher: (rule) => rule.resolvedSpecifierMatcher,
  });

  return {
    hasResolvedSpecifierPatterns:
      resolvedExact.size > 0 ||
      resolvedWildcard.length > 0 ||
      resolvedImporterRules.length > 0,
    matchRaw,
    matchResolved,
    match(specifier, parentUrl = "", resolvedSpecifier = "") {
      const rawBucket = matchRaw(specifier, parentUrl);
      if (rawBucket) {
        return rawBucket;
      }

      if (!resolvedSpecifier) {
        return null;
      }

      return matchResolved(resolvedSpecifier, parentUrl);
    },
  };
}

function createMatchFn({
  exact,
  exactPackageSubpaths,
  wildcard,
  importerRules,
  cache,
  getRuleMatcher,
}) {
  return (specifier, parentUrl = "") => {
    const cacheKey = `${parentUrl}\u0000${specifier}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    let bucket = null;

    if (exact.has(specifier)) {
      bucket = exact.get(specifier);
      cache.set(cacheKey, bucket);
      return bucket;
    }

    for (const mapping of exactPackageSubpaths) {
      if (specifier.startsWith(mapping.packageSubpathPrefix)) {
        bucket = mapping.bucket;
        cache.set(cacheKey, bucket);
        return bucket;
      }
    }

    for (const mapping of wildcard) {
      if (specifier.startsWith(mapping.prefix)) {
        bucket = mapping.bucket;
        cache.set(cacheKey, bucket);
        return bucket;
      }
    }

    if (importerRules.length > 0) {
      for (const rule of importerRules) {
        if (!patternMatches(getRuleMatcher(rule), specifier)) {
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

    cache.set(cacheKey, null);
    return null;
  };
}

function assertCanonicalPackageOwnership(
  packageMappings,
  importerRules,
  sourcePath = "",
) {
  for (const rule of importerRules) {
    for (const mapping of packageMappings) {
      if (rule.bucket === mapping.bucket) {
        continue;
      }

      if (
        patternsOverlap(rule.specifierMatcher, mapping.matcher) ||
        patternsOverlap(rule.specifierMatcher, mapping.packageSubpathMatcher) ||
        patternsOverlap(rule.resolvedSpecifierMatcher, mapping.resolvedMatcher)
      ) {
        throw new Error(
          `Policy importerRules cannot remap canonical package ownership for specifier "${rule.specifierPattern}" to bucket "${rule.bucket}" because it overlaps package mapping "${mapping.pattern}" owned by "${mapping.bucket}" (${sourcePath || "unknown source"})`,
        );
      }
    }
  }
}

function normalizeImporterRule({ importerPattern, specifierPattern, bucket }) {
  return {
    bucket,
    importerPattern,
    specifierPattern,
    importerMatcher: toPatternMatcher(importerPattern),
    specifierMatcher: toPatternMatcher(specifierPattern),
    resolvedSpecifierPattern: resolvePolicySpecifierPattern(specifierPattern),
    resolvedSpecifierMatcher: toResolvedPatternMatcher(specifierPattern),
  };
}

function compareImporterRules(a, b) {
  const specifierTypeRankDiff =
    patternTypeRank(a.specifierMatcher.type) -
    patternTypeRank(b.specifierMatcher.type);
  if (specifierTypeRankDiff !== 0) {
    return specifierTypeRankDiff;
  }

  if (a.specifierMatcher.anchorLength !== b.specifierMatcher.anchorLength) {
    return b.specifierMatcher.anchorLength - a.specifierMatcher.anchorLength;
  }

  const importerTypeRankDiff =
    patternTypeRank(a.importerMatcher.type) -
    patternTypeRank(b.importerMatcher.type);
  if (importerTypeRankDiff !== 0) {
    return importerTypeRankDiff;
  }

  return b.importerMatcher.anchorLength - a.importerMatcher.anchorLength;
}

function compareResolvedImporterRules(a, b) {
  const specifierTypeRankDiff =
    patternTypeRank(a.resolvedSpecifierMatcher.type) -
    patternTypeRank(b.resolvedSpecifierMatcher.type);
  if (specifierTypeRankDiff !== 0) {
    return specifierTypeRankDiff;
  }

  if (
    a.resolvedSpecifierMatcher.anchorLength !==
    b.resolvedSpecifierMatcher.anchorLength
  ) {
    return (
      b.resolvedSpecifierMatcher.anchorLength -
      a.resolvedSpecifierMatcher.anchorLength
    );
  }

  const importerTypeRankDiff =
    patternTypeRank(a.importerMatcher.type) -
    patternTypeRank(b.importerMatcher.type);
  if (importerTypeRankDiff !== 0) {
    return importerTypeRankDiff;
  }

  return b.importerMatcher.anchorLength - a.importerMatcher.anchorLength;
}

function patternTypeRank(type) {
  if (type === "exact") {
    return 0;
  }

  if (type === "prefix") {
    return 1;
  }

  return 2;
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
  if (!matcher) {
    return false;
  }

  if (matcher.type === "any") {
    return true;
  }

  if (matcher.type === "prefix") {
    return value.startsWith(matcher.anchor);
  }

  return value === matcher.anchor;
}

function patternsOverlap(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.type === "any" || right.type === "any") {
    return true;
  }

  if (left.type === "exact" && right.type === "exact") {
    return left.anchor === right.anchor;
  }

  if (left.type === "exact" && right.type === "prefix") {
    return left.anchor.startsWith(right.anchor);
  }

  if (left.type === "prefix" && right.type === "exact") {
    return right.anchor.startsWith(left.anchor);
  }

  return (
    left.anchor.startsWith(right.anchor) || right.anchor.startsWith(left.anchor)
  );
}

function resolvePolicySpecifierPattern(pattern) {
  if (!isLocalLikeSpecifier(pattern)) {
    return null;
  }

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return `${resolvePolicySpecifierValue(prefix)}*`;
  }

  return resolvePolicySpecifierValue(pattern);
}

function toResolvedPatternMatcher(pattern) {
  const resolvedPattern = resolvePolicySpecifierPattern(pattern);
  if (!resolvedPattern) {
    return null;
  }

  return toPatternMatcher(resolvedPattern);
}

function isLocalLikeSpecifier(specifier) {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("file://") ||
    path.isAbsolute(specifier)
  );
}

function getPackageSubpathPrefix(pattern) {
  if (!isBarePackageRootSpecifier(pattern)) {
    return null;
  }

  return `${pattern}/`;
}

function toPackageSubpathMatcher(pattern) {
  const prefix = getPackageSubpathPrefix(pattern);
  if (!prefix) {
    return null;
  }

  return {
    type: "prefix",
    anchorLength: prefix.length,
    anchor: prefix,
  };
}

function isBarePackageRootSpecifier(specifier) {
  if (
    specifier === "*" ||
    specifier.includes("*") ||
    isLocalLikeSpecifier(specifier) ||
    specifier.startsWith("node:") ||
    specifier.startsWith("file:")
  ) {
    return false;
  }

  if (specifier.startsWith("@")) {
    const segments = specifier.split("/");
    return segments.length === 2 && segments[0].length > 1 && segments[1].length > 0;
  }

  return !specifier.includes("/");
}

function resolvePolicySpecifierValue(value) {
  if (value.startsWith("file://")) {
    return value;
  }

  if (path.isAbsolute(value)) {
    return pathToFileURL(value).href;
  }

  const hasTrailingSeparator = needsTrailingSeparator(value);
  const resolvedPath = path.resolve(process.cwd(), value);
  const resolvedUrl = pathToFileURL(resolvedPath).href;
  return hasTrailingSeparator ? appendTrailingSeparator(resolvedUrl) : resolvedUrl;
}

function needsTrailingSeparator(value) {
  return value.endsWith("/") || value.endsWith(path.sep);
}

function appendTrailingSeparator(value) {
  return value.endsWith("/") ? value : `${value}/`;
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

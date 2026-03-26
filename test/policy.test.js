import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPolicyMatcher, normalizePolicy } from "../src/policy/index.js";

test("policy matcher prefers exact over wildcard and longest wildcard prefix", () => {
  const policy = normalizePolicy({
    buckets: {
      exactBucket: {},
      wildcardBucket: {},
      longWildcardBucket: {},
    },
    packages: {
      pkg: "exactBucket",
      "pkg/*": "wildcardBucket",
      "pkg/sub/*": "longWildcardBucket",
    },
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match("pkg"), "exactBucket");
  assert.equal(matcher.match("pkg/any"), "wildcardBucket");
  assert.equal(matcher.match("pkg/sub/path"), "longWildcardBucket");
  assert.equal(matcher.match("other"), null);
});

test("policy matcher falls back to the resolved file URL for local exact entries", () => {
  const depPath = path.resolve(process.cwd(), "src/dep.mjs");
  const depUrl = pathToFileURL(depPath).href;
  const policy = normalizePolicy({
    buckets: {
      localBucket: {},
    },
    packages: {
      "./src/dep.mjs": "localBucket",
    },
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match(depPath, "file:///app/main.mjs", depUrl), "localBucket");
});

test("policy matcher falls back to the resolved file URL for local wildcard entries", () => {
  const depPath = path.resolve(process.cwd(), "src/nested/dep.mjs");
  const depUrl = pathToFileURL(depPath).href;
  const policy = normalizePolicy({
    buckets: {
      localBucket: {},
    },
    packages: {
      "./src/*": "localBucket",
    },
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match(depPath, "file:///app/main.mjs", depUrl), "localBucket");
});

test("policy matcher supports importerRules with deterministic precedence", () => {
  const policy = normalizePolicy({
    buckets: {
      defaultBucket: {},
      restrictedBucket: {},
      narrowBucket: {},
    },
    packages: {
      "sandboxed-lib": "defaultBucket",
    },
    importerRules: [
      {
        importer: "file:///app/src/restricted/*",
        specifier: "sandboxed-lib",
        bucket: "restrictedBucket",
      },
      {
        importer: "file:///app/src/restricted/narrow/*",
        specifier: "sandboxed-lib",
        bucket: "narrowBucket",
      },
    ],
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(
    matcher.match("sandboxed-lib", "file:///app/src/restricted/module.mjs"),
    "restrictedBucket",
  );
  assert.equal(
    matcher.match(
      "sandboxed-lib",
      "file:///app/src/restricted/narrow/module.mjs",
    ),
    "narrowBucket",
  );
  assert.equal(
    matcher.match("sandboxed-lib", "file:///app/src/open/module.mjs"),
    "defaultBucket",
  );
});

test("policy matcher keeps raw local specifier matches ahead of resolved fallback matches", () => {
  const depPath = path.resolve(process.cwd(), "src/dep.mjs");
  const depUrl = pathToFileURL(depPath).href;
  const policy = normalizePolicy({
    buckets: {
      rawBucket: {},
      resolvedBucket: {},
    },
    packages: {
      "./src/dep.mjs": "resolvedBucket",
      [depPath]: "rawBucket",
    },
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match(depPath, "file:///app/main.mjs", depUrl), "rawBucket");
});

test("policy matcher supports importerRules with resolved local specifier fallback", () => {
  const depPath = path.resolve(process.cwd(), "src/dep.mjs");
  const depUrl = pathToFileURL(depPath).href;
  const policy = normalizePolicy({
    buckets: {
      localBucket: {},
      fallbackBucket: {},
    },
    packages: {
      "some-package": "fallbackBucket",
    },
    importerRules: [
      {
        importer: "file:///app/restricted/*",
        specifier: "./src/dep.mjs",
        bucket: "localBucket",
      },
    ],
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(
    matcher.match(depPath, "file:///app/restricted/main.mjs", depUrl),
    "localBucket",
  );
  assert.equal(matcher.match(depPath, "file:///app/open/main.mjs", depUrl), null);
});

test("policy normalization handles arrays, env values, and importer rule precedence", () => {
  const policy = normalizePolicy({
    buckets: {
      exactBucket: {
        allowNet: ["example.com", "api.example.com"],
        allowFsRead: "*",
        allowFsWrite: false,
        allowChildProcess: 1,
        allowWorker: 0,
        allowAddons: "yes",
        allowWasi: "",
        allowInspector: true,
        env: {
          PORT: 3000,
          ENABLED: false,
        },
      },
      anyBucket: {},
      prefixBucket: {},
      prefixImporterBucket: {},
      exactImporterBucket: {},
    },
    packages: {},
    importerRules: [
      {
        importer: "*",
        specifier: "*",
        bucket: "anyBucket",
      },
      {
        importer: "*",
        specifier: "pkg/*",
        bucket: "prefixBucket",
      },
      {
        importer: "file:///app/*",
        specifier: "pkg/deep/*",
        bucket: "prefixImporterBucket",
      },
      {
        importer: "file:///app/exact.mjs",
        specifier: "pkg/deep/*",
        bucket: "exactImporterBucket",
      },
      {
        importer: "*",
        specifier: "pkg/exact",
        bucket: "exactBucket",
      },
    ],
  });

  assert.deepEqual(policy.buckets.exactBucket.allowNet, [
    "example.com",
    "api.example.com",
  ]);
  assert.equal(policy.buckets.exactBucket.allowFsRead, "*");
  assert.equal(policy.buckets.exactBucket.allowFsWrite, false);
  assert.deepEqual(policy.buckets.exactBucket.env, {
    PORT: "3000",
    ENABLED: "false",
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match("other-lib", "file:///elsewhere.mjs"), "anyBucket");
  assert.equal(matcher.match("pkg/exact", "file:///elsewhere.mjs"), "exactBucket");
  assert.equal(
    matcher.match("pkg/deep/module", "file:///app/other.mjs"),
    "prefixImporterBucket",
  );
  assert.equal(
    matcher.match("pkg/deep/module", "file:///app/exact.mjs"),
    "exactImporterBucket",
  );
});

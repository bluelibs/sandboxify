import test from "node:test";
import assert from "node:assert/strict";
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

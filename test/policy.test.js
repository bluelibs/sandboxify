import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyMatcher, normalizePolicy } from '../src/policy/index.js';

test('policy matcher prefers exact over wildcard and longest wildcard prefix', () => {
  const policy = normalizePolicy({
    buckets: {
      exactBucket: {},
      wildcardBucket: {},
      longWildcardBucket: {},
    },
    packages: {
      'pkg': 'exactBucket',
      'pkg/*': 'wildcardBucket',
      'pkg/sub/*': 'longWildcardBucket',
    },
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(matcher.match('pkg'), 'exactBucket');
  assert.equal(matcher.match('pkg/any'), 'wildcardBucket');
  assert.equal(matcher.match('pkg/sub/path'), 'longWildcardBucket');
  assert.equal(matcher.match('other'), null);
});

test('policy matcher supports importerRules with deterministic precedence', () => {
  const policy = normalizePolicy({
    buckets: {
      defaultBucket: {},
      restrictedBucket: {},
      narrowBucket: {},
    },
    packages: {
      'sandboxed-lib': 'defaultBucket',
    },
    importerRules: [
      {
        importer: 'file:///app/src/restricted/*',
        specifier: 'sandboxed-lib',
        bucket: 'restrictedBucket',
      },
      {
        importer: 'file:///app/src/restricted/narrow/*',
        specifier: 'sandboxed-lib',
        bucket: 'narrowBucket',
      },
    ],
  });

  const matcher = createPolicyMatcher(policy);

  assert.equal(
    matcher.match('sandboxed-lib', 'file:///app/src/restricted/module.mjs'),
    'restrictedBucket',
  );
  assert.equal(
    matcher.match('sandboxed-lib', 'file:///app/src/restricted/narrow/module.mjs'),
    'narrowBucket',
  );
  assert.equal(
    matcher.match('sandboxed-lib', 'file:///app/src/open/module.mjs'),
    'defaultBucket',
  );
});

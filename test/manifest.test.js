import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, readManifestSync } from '../src/manifest/index.js';

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('buildManifest writes entries and can be read back', { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxify-manifest-'));

  try {
    writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'manifest-fixture-app', type: 'module', private: true }, null, 2),
    );

    writeFile(
      path.join(tmpDir, 'node_modules', 'fixture-lib', 'package.json'),
      JSON.stringify(
        {
          name: 'fixture-lib',
          version: '1.0.0',
          type: 'module',
          exports: './index.mjs',
        },
        null,
        2,
      ),
    );

    writeFile(
      path.join(tmpDir, 'node_modules', 'fixture-lib', 'index.mjs'),
      'export const named = 42; export default function hello() { return "hi"; }\n',
    );

    writeFile(
      path.join(tmpDir, 'sandboxify.policy.jsonc'),
      JSON.stringify(
        {
          buckets: {
            cpu_only: {
              allowNet: false,
              allowFsRead: ['./node_modules'],
              allowFsWrite: [],
              allowChildProcess: false,
              allowWorker: false,
              allowAddons: false,
            },
          },
          packages: {
            'fixture-lib': 'cpu_only',
          },
        },
        null,
        2,
      ),
    );

    process.chdir(tmpDir);

    const manifestPath = './.sandboxify/exports.manifest.json';
    const manifest = await buildManifest({ policyPath: './sandboxify.policy.jsonc', manifestPath });

    assert.equal(manifest.version, 1);
    assert.ok(manifest.entriesBySpecifier['fixture-lib']);
    assert.ok(Array.isArray(manifest.entriesBySpecifier['fixture-lib'].exportNames));
    assert.ok(manifest.entriesBySpecifier['fixture-lib'].exportNames.includes('default'));
    assert.ok(manifest.entriesBySpecifier['fixture-lib'].exportNames.includes('named'));

    const loaded = readManifestSync(manifestPath);
    assert.deepEqual(loaded.entriesBySpecifier['fixture-lib'].exportNames.sort(), ['default', 'named']);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

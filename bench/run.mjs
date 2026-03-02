import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildManifest } from '../src/manifest/index.js';
import { writeReport } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
const profile = args.profile === 'full' ? 'full' : 'smoke';

const policyPath = './bench/sandboxify.bench.policy.jsonc';
const manifestPath = './bench/.sandboxify/exports.manifest.json';
const resultsDir = path.resolve(process.cwd(), 'bench/results');

await buildManifest({ policyPath, manifestPath });

const scenarios = ['rpc-noop', 'rpc-batch-noop', 'echo-payload', 'mixed-workload'];
const modes = ['native', 'bypass', 'sandbox'];
const runs = [];

for (const scenario of scenarios) {
  for (const mode of modes) {
    const result = await runWorker({ scenario, mode, profile, policyPath, manifestPath });
    runs.push(...result.runs);
  }
}

const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, '-');
const output = {
  version: 1,
  generatedAt: now.toISOString(),
  profile,
  nodeVersion: process.version,
  benchmarkConfig: {
    ipcBlobThresholdBytes: process.env.SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES ?? null,
  },
  runs,
};

fs.mkdirSync(resultsDir, { recursive: true });
const resultPath = path.join(resultsDir, `${timestamp}-${profile}.json`);
const latestPath = path.join(resultsDir, `latest-${profile}.json`);

fs.writeFileSync(resultPath, JSON.stringify(output, null, 2));
fs.writeFileSync(latestPath, JSON.stringify(output, null, 2));

writeReport({
  outputPath: path.resolve(process.cwd(), 'bench/REPORT.md'),
  result: output,
});

console.log(`[bench] profile=${profile}`);
console.log(`[bench] runs=${runs.length}`);
console.log(`[bench] result=${path.relative(process.cwd(), resultPath)}`);
console.log('[bench] report=bench/REPORT.md');

function runWorker({ scenario, mode, profile, policyPath, manifestPath }) {
  return new Promise((resolve, reject) => {
    const nodeArgs = [];
    const env = {
      ...process.env,
      SANDBOXIFY_POLICY_PATH: policyPath,
      SANDBOXIFY_MANIFEST_PATH: manifestPath,
    };

    if (mode === 'bypass' || mode === 'sandbox') {
      nodeArgs.push('--import', './register.mjs');
    }

    if (mode === 'bypass') {
      env.SANDBOXIFY_DISABLE = '1';
    } else {
      delete env.SANDBOXIFY_DISABLE;
    }

    nodeArgs.push('./bench/worker.mjs', '--scenario', scenario, '--mode', mode, '--profile', profile);

    const child = spawn(process.execPath, nodeArgs, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`[bench] worker failed (${scenario}/${mode}): ${stderr || stdout}`));
        return;
      }

      const line = stdout
        .trim()
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .at(-1);

      if (!line) {
        reject(new Error(`[bench] worker produced no JSON output (${scenario}/${mode})`));
        return;
      }

      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`[bench] invalid worker JSON (${scenario}/${mode}): ${error.message}\n${line}`));
      }
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

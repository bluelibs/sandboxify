import { execFileSync } from 'node:child_process';
import { makePayload, estimatePayloadBytes } from './lib/payloads.mjs';
import { nowMs, summarizeLatencies } from './lib/stats.mjs';

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario;
const mode = args.mode;
const profile = args.profile;

if (!scenario || !mode || !profile) {
  console.error('Usage: node bench/worker.mjs --scenario <name> --mode <native|bypass|sandbox> --profile <smoke|full>');
  process.exit(1);
}

const target = await import('#sandboxify-bench-target');

if (scenario === 'rpc-noop') {
  const iterations = profile === 'full' ? 30000 : 6000;
  emit(await runRpcNoop({ target, mode, scenario, iterations }));
  process.exit(0);
}

if (scenario === 'rpc-batch-noop') {
  const batchSize = profile === 'full' ? 32 : 16;
  const groups = profile === 'full' ? 3000 : 800;
  emit(await runRpcBatchNoop({ target, mode, scenario: `rpc-batch-noop-${batchSize}`, groups, batchSize }));
  process.exit(0);
}

if (scenario === 'echo-payload') {
  const sizes = profile === 'full'
    ? [0, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 10485760, 16777216]
    : [0, 1024, 65536, 1048576];
  const payloadTypes = ['buffer', 'uint8array', 'json'];
  const iterationsPerCase = profile === 'full' ? 1200 : 300;
  const results = [];

  for (const payloadType of payloadTypes) {
    for (const payloadSizeBytes of sizes) {
      results.push(
        await runEchoPayload({
          target,
          mode,
          scenario,
          payloadType,
          payloadSizeBytes,
          iterations: iterationsPerCase,
        }),
      );
    }
  }

  emitMany(results);
  process.exit(0);
}

if (scenario === 'mixed-workload') {
  const iterations = profile === 'full' ? 12000 : 2500;
  emit(await runMixedWorkload({ target, mode, scenario, iterations }));
  process.exit(0);
}

console.error(`Unknown scenario: ${scenario}`);
process.exit(1);

async function runRpcNoop({ target, mode, scenario, iterations }) {
  return benchmarkCommon({
    mode,
    scenario,
    iterations,
    execute: async () => {
      await target.rpcNoop();
      return 0;
    },
  });
}

async function runRpcBatchNoop({ target, mode, scenario, groups, batchSize }) {
  const batchArgs = Array.from({ length: batchSize }, () => []);
  return benchmarkCommon({
    mode,
    scenario,
    iterations: groups,
    operationsPerIteration: batchSize,
    execute: async () => {
      if (typeof target.rpcNoop?.batch === 'function') {
        await target.rpcNoop.batch(batchArgs);
        return 0;
      }

      for (let i = 0; i < batchSize; i += 1) {
        await target.rpcNoop();
      }

      return 0;
    },
  });
}

async function runEchoPayload({ target, mode, scenario, payloadType, payloadSizeBytes, iterations }) {
  const payload = makePayload(payloadType, payloadSizeBytes);
  return benchmarkCommon({
    mode,
    scenario,
    payloadType,
    payloadSizeBytes,
    iterations,
    execute: async () => {
      const echoed = await target.echoPayload(payload);
      return estimatePayloadBytes(echoed);
    },
  });
}

async function runMixedWorkload({ target, mode, scenario, iterations }) {
  const picks = [
    { weight: 70, payloadType: 'json', payloadSizeBytes: 512 },
    { weight: 25, payloadType: 'buffer', payloadSizeBytes: 65536 },
    { weight: 5, payloadType: 'uint8array', payloadSizeBytes: 1048576 },
  ];

  const weighted = [];
  for (const pick of picks) {
    for (let i = 0; i < pick.weight; i += 1) {
      weighted.push(pick);
    }
  }

  const payloads = new Map();

  return benchmarkCommon({
    mode,
    scenario,
    iterations,
    execute: async (index) => {
      const pick = weighted[index % weighted.length];
      const key = `${pick.payloadType}:${pick.payloadSizeBytes}`;
      if (!payloads.has(key)) {
        payloads.set(key, makePayload(pick.payloadType, pick.payloadSizeBytes));
      }

      const payload = payloads.get(key);
      const echoed = await target.echoPayload(payload);
      return estimatePayloadBytes(echoed);
    },
  });
}

async function benchmarkCommon({ mode, scenario, payloadType = null, payloadSizeBytes = null, iterations, operationsPerIteration = 1, execute }) {
  const latenciesMs = [];
  let bytesReturned = 0;
  let parentRssPeakBytes = process.memoryUsage().rss;

  const startCpu = process.resourceUsage();
  const startedAtMs = nowMs();

  for (let i = 0; i < iterations; i += 1) {
    const opStart = nowMs();
    bytesReturned += await execute(i);
    const opEnd = nowMs();

    latenciesMs.push(opEnd - opStart);

    if ((i & 63) === 0) {
      const rss = process.memoryUsage().rss;
      if (rss > parentRssPeakBytes) {
        parentRssPeakBytes = rss;
      }
    }
  }

  const endedAtMs = nowMs();
  const endCpu = process.resourceUsage();
  const totalOperations = Math.max(iterations * operationsPerIteration, 1);

  const totalMs = Math.max(endedAtMs - startedAtMs, 0.0001);
  const latencyMs = summarizeLatencies(latenciesMs);

  const userMicros = Math.max(endCpu.userCPUTime - startCpu.userCPUTime, 0);
  const systemMicros = Math.max(endCpu.systemCPUTime - startCpu.systemCPUTime, 0);

  const childPid = mode === 'sandbox' ? await detectSandboxChildPid() : null;
  const childRssMb = childPid ? readChildRssMb(childPid) : null;

  return {
    mode,
    scenario,
    payloadType,
    payloadSizeBytes,
    iterations: totalOperations,
    iterationGroups: iterations,
    batchSize: operationsPerIteration,
    throughput: {
      opsPerSec: (totalOperations * 1000) / totalMs,
    },
    latencyMs,
    cpu: {
      userMicrosPerOp: userMicros / totalOperations,
      systemMicrosPerOp: systemMicros / totalOperations,
    },
    memory: {
      parentRssPeakMb: parentRssPeakBytes / (1024 * 1024),
      childRssMb,
    },
    bytesReturned,
  };
}

async function detectSandboxChildPid() {
  try {
    const { getRuntimePool } = await import('../src/runtime/index.js');
    const pool = getRuntimePool();
    for (const client of pool.clients.values()) {
      if (client?.proc?.pid) {
        return client.proc.pid;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function readChildRssMb(pid) {
  try {
    const raw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const kb = Number.parseInt(raw, 10);
    if (!Number.isFinite(kb)) return null;
    return kb / 1024;
  } catch {
    return null;
  }
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

function emit(value) {
  process.stdout.write(`${JSON.stringify({ runs: [value] })}\n`);
}

function emitMany(values) {
  process.stdout.write(`${JSON.stringify({ runs: values })}\n`);
}

import fs from "node:fs";
import path from "node:path";

function fmt(num, digits = 2) {
  if (!Number.isFinite(num)) return "n/a";
  return num.toFixed(digits);
}

function keyFor(run) {
  if (run.scenario === "rpc-noop") {
    return "rpc-noop";
  }

  if (run.scenario === "echo-payload") {
    return `echo-${run.payloadType}-${run.payloadSizeBytes}`;
  }

  return run.scenario;
}

export function writeReport({ outputPath, result }) {
  const grouped = new Map();
  for (const run of result.runs) {
    const key = keyFor(run);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(run);
  }

  const lines = [];
  lines.push("# Benchmark Report");
  lines.push("");
  lines.push(`- Generated: ${result.generatedAt}`);
  lines.push(`- Profile: ${result.profile}`);
  lines.push(`- Node: ${result.nodeVersion}`);
  lines.push(`- Runs: ${result.runs.length}`);
  lines.push(
    `- IPC blob threshold (bytes): ${result.benchmarkConfig?.ipcBlobThresholdBytes ?? "default"}`,
  );
  lines.push("");
  lines.push("## What This Benchmark Measures");
  lines.push("");
  lines.push(
    "- Goal: quantify sandbox process-boundary overhead against native execution.",
  );
  lines.push("- `native`: direct in-process calls to the benchmark target.");
  lines.push(
    "- `bypass`: loader path active with `SANDBOXIFY_DISABLE=1` (estimates loader/framework overhead without sandbox RPC).",
  );
  lines.push(
    "- `sandbox`: full sandbox path (loader + runtime pool + IPC RPC + permissioned child process).",
  );
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  lines.push(
    "- `rpc-noop`: minimal call overhead baseline (very small payload and compute).",
  );
  lines.push(
    "- `rpc-batch-noop-<N>`: batched noop calls using one RPC for `N` logical operations (when batch API is available).",
  );
  lines.push(
    "- `echo-<type>-<size>`: round-trip payload transfer cost for `buffer`, `uint8array`, and `json`.",
  );
  lines.push(
    "- `mixed-workload`: representative blend (mostly small JSON, some medium/large binary payloads).",
  );
  lines.push(
    "- `remote-work-200ms`: tiny request/response with about 200 ms of work inside the target, to show how RPC overhead amortizes when useful work dominates.",
  );
  lines.push("");
  lines.push("## How To Read The Tables");
  lines.push("");
  lines.push("- `ops/sec`: higher is better throughput.");
  lines.push("- `p95/p99`: tail latency; important for user-facing spikes.");
  lines.push(
    "- For `rpc-batch-noop-<N>`, latency values are per **batch request** while throughput remains in logical ops/sec.",
  );
  lines.push("- `CPU us/op`: combined user+system CPU per operation.");
  lines.push(
    "- `Parent RSS MB` / `Child RSS MB`: memory footprint in caller and sandbox process.",
  );
  lines.push(
    "- Summary bullets after each table compare sandbox vs native to make overhead explicit.",
  );
  lines.push("");

  for (const [key, runs] of grouped.entries()) {
    lines.push(`## ${key}`);
    lines.push("");
    lines.push(
      "| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

    const byMode = new Map(runs.map((run) => [run.mode, run]));
    for (const mode of ["native", "bypass", "sandbox"]) {
      const run = byMode.get(mode);
      if (!run) {
        lines.push(`| ${mode} | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
        continue;
      }

      const cpuTotal = run.cpu.userMicrosPerOp + run.cpu.systemMicrosPerOp;
      lines.push(
        `| ${mode} | ${fmt(run.throughput.opsPerSec)} | ${fmt(run.latencyMs.p95)} | ${fmt(run.latencyMs.p99)} | ${fmt(run.latencyMs.max)} | ${fmt(cpuTotal, 1)} | ${fmt(run.memory.parentRssPeakMb)} | ${fmt(run.memory.childRssMb)} |`,
      );
    }

    const native = byMode.get("native");
    const sandbox = byMode.get("sandbox");
    if (
      native &&
      sandbox &&
      native.latencyMs.p95 > 0 &&
      native.throughput.opsPerSec > 0
    ) {
      const p95Overhead = sandbox.latencyMs.p95 / native.latencyMs.p95;
      const throughputDropPct =
        ((native.throughput.opsPerSec - sandbox.throughput.opsPerSec) /
          native.throughput.opsPerSec) *
        100;
      lines.push("");
      lines.push(`- Sandbox vs native p95 overhead: ${fmt(p95Overhead)}x`);
      lines.push(
        `- Sandbox vs native throughput drop: ${fmt(throughputDropPct)}%`,
      );
    }

    lines.push("");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
}

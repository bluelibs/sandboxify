# BENCHMARK_PLAN

## Goal
Quantify the overhead of sandboxed dependency execution (IPC + structured clone + process boundary) versus native execution, with special focus on large payloads (including 10MB buffers).

## Baselines
- **A (Native):** direct in-process function call.
- **B (Bypass):** loader path enabled with `SANDBOXIFY_DISABLE=1`.
- **C (Sandbox):** full sandboxify path enabled.

## Metrics
- Latency: p50 / p95 / p99 / max
- Throughput: ops/sec
- CPU: user/system time per op
- Memory: parent RSS + child RSS peak
- Serialization cost estimate: round-trip minus callee compute time

## Benchmark Matrix
### Payload sizes
`0B, 256B, 1KB, 4KB, 16KB, 64KB, 256KB, 1MB, 4MB, 10MB, 16MB`

### Payload types
- `Buffer`
- `Uint8Array`
- JSON-like object of equivalent size

### Traffic directions
- request-heavy (large in, tiny out)
- response-heavy (tiny in, large out)
- symmetric (large in, large out)

### Concurrency
`1, 4, 16, 64`

### Temperature
- cold (includes sandbox spawn + load)
- warm (reused process + cache)

## Scenarios
1. **rpc-noop**: fixed overhead
2. **echo-payload**: round-trip serialization
3. **compute-small-payload**: amortization under CPU work
4. **mixed-workload**: 70% small, 25% medium, 5% large
5. **10mb-burst**: repeated high-volume payload transfer

## Pass/Fail thresholds (initial)
- Small payloads (<=64KB): p95 overhead vs native <= 2.0x
- Medium payloads (256KB-1MB): throughput drop <= 60%
- 10MB case at concurrency=1: p95 <= 250ms
- 10MB case at concurrency=4: no crash/OOM
- Regression gate (vs main baseline): fail on >15% p95 increase or >15% throughput drop in priority scenarios

## Implementation steps
1. Add benchmark harness in `bench/` with JSON output.
2. Implement microbench scripts (`rpc-noop`, `echo`, `compute`).
3. Implement macrobench script (`mixed-workload`, `10mb-burst`).
4. Add reporter that compares current results against saved baseline.
5. Add CI jobs:
   - PR smoke matrix (small + 1MB + 10MB)
   - nightly full matrix

## Deliverables
- `bench/results/*.json`
- `bench/REPORT.md` generated comparison summary
- CI checks with threshold enforcement

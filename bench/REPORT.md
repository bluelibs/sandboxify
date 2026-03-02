# Benchmark Report

- Generated: 2026-03-02T15:25:08.808Z
- Profile: smoke
- Node: v25.7.0
- Runs: 45
- IPC blob threshold (bytes): default

## What This Benchmark Measures

- Goal: quantify sandbox process-boundary overhead against native execution.
- `native`: direct in-process calls to the benchmark target.
- `bypass`: loader path active with `SANDBOXIFY_DISABLE=1` (estimates loader/framework overhead without sandbox RPC).
- `sandbox`: full sandbox path (loader + runtime pool + IPC RPC + permissioned child process).

## Scenarios

- `rpc-noop`: minimal call overhead baseline (very small payload and compute).
- `rpc-batch-noop-<N>`: batched noop calls using one RPC for `N` logical operations (when batch API is available).
- `echo-<type>-<size>`: round-trip payload transfer cost for `buffer`, `uint8array`, and `json`.
- `mixed-workload`: representative blend (mostly small JSON, some medium/large binary payloads).

## How To Read The Tables

- `ops/sec`: higher is better throughput.
- `p95/p99`: tail latency; important for user-facing spikes.
- For `rpc-batch-noop-<N>`, latency values are per **batch request** while throughput remains in logical ops/sec.
- `CPU us/op`: combined user+system CPU per operation.
- `Parent RSS MB` / `Child RSS MB`: memory footprint in caller and sandbox process.
- Summary bullets after each table compare sandbox vs native to make overhead explicit.

## rpc-noop

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2101055.15 | 0.00 | 0.00 | 0.31 | 0.7 | 52.19 | n/a |
| bypass | 2361468.40 | 0.00 | 0.00 | 0.33 | 0.6 | 54.66 | n/a |
| sandbox | 22188.75 | 0.09 | 0.26 | 3.29 | 25.5 | 71.59 | 65.39 |

- Sandbox vs native p95 overhead: 303.46x
- Sandbox vs native throughput drop: 98.94%

## rpc-batch-noop-16

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 6524506.93 | 0.00 | 0.01 | 0.38 | 0.2 | 52.22 | n/a |
| bypass | 7956280.50 | 0.00 | 0.01 | 0.36 | 0.2 | 54.36 | n/a |
| sandbox | 224977.64 | 0.13 | 0.27 | 0.45 | 2.7 | 61.14 | 60.64 |

- Sandbox vs native p95 overhead: 41.52x
- Sandbox vs native throughput drop: 96.55%

## echo-buffer-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 777705.66 | 0.00 | 0.01 | 0.05 | 2.1 | 49.84 | n/a |
| bypass | 608725.45 | 0.00 | 0.01 | 0.15 | 3.8 | 53.64 | n/a |
| sandbox | 2555.08 | 1.39 | 2.79 | 3.10 | 88.3 | 58.25 | 54.98 |

- Sandbox vs native p95 overhead: 723.17x
- Sandbox vs native throughput drop: 99.67%

## echo-buffer-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 456505.66 | 0.00 | 0.01 | 0.40 | 3.3 | 50.69 | n/a |
| bypass | 558442.83 | 0.00 | 0.01 | 0.30 | 3.2 | 54.66 | n/a |
| sandbox | 6194.66 | 0.51 | 1.13 | 1.39 | 68.6 | 61.63 | 56.14 |

- Sandbox vs native p95 overhead: 266.30x
- Sandbox vs native throughput drop: 98.64%

## echo-buffer-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1581369.79 | 0.00 | 0.00 | 0.02 | 0.6 | 51.56 | n/a |
| bypass | 2315870.53 | 0.00 | 0.00 | 0.01 | 1.0 | 54.70 | n/a |
| sandbox | 938.45 | 3.16 | 4.08 | 4.53 | 180.2 | 113.98 | 127.53 |

- Sandbox vs native p95 overhead: 2296.45x
- Sandbox vs native throughput drop: 99.94%

## echo-buffer-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 864448.47 | 0.00 | 0.01 | 0.07 | 0.7 | 52.86 | n/a |
| bypass | 1465502.22 | 0.00 | 0.01 | 0.02 | 0.6 | 55.58 | n/a |
| sandbox | 314.80 | 9.46 | 14.98 | 31.06 | 1335.9 | 205.84 | 225.42 |

- Sandbox vs native p95 overhead: 6482.10x
- Sandbox vs native throughput drop: 99.96%

## echo-uint8array-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 362811.80 | 0.00 | 0.00 | 0.02 | 2.3 | 53.33 | n/a |
| bypass | 2429956.87 | 0.00 | 0.00 | 0.00 | 0.4 | 55.58 | n/a |
| sandbox | 14059.31 | 0.20 | 0.46 | 0.63 | 36.9 | 206.02 | 226.72 |

- Sandbox vs native p95 overhead: 538.59x
- Sandbox vs native throughput drop: 96.12%

## echo-uint8array-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2357562.45 | 0.00 | 0.00 | 0.00 | 0.5 | 53.33 | n/a |
| bypass | 1128528.48 | 0.00 | 0.00 | 0.09 | 0.9 | 55.61 | n/a |
| sandbox | 8547.73 | 0.35 | 0.67 | 1.20 | 47.1 | 206.06 | 226.91 |

- Sandbox vs native p95 overhead: 1049.80x
- Sandbox vs native throughput drop: 99.64%

## echo-uint8array-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2624855.05 | 0.00 | 0.00 | 0.00 | 0.4 | 53.33 | n/a |
| bypass | 1746297.54 | 0.00 | 0.00 | 0.05 | 0.4 | 55.61 | n/a |
| sandbox | 4749.32 | 0.68 | 1.16 | 1.48 | 87.3 | 206.22 | 231.73 |

- Sandbox vs native p95 overhead: 2319.20x
- Sandbox vs native throughput drop: 99.82%

## echo-uint8array-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2298129.14 | 0.00 | 0.00 | 0.01 | 0.4 | 54.05 | n/a |
| bypass | 2185791.30 | 0.00 | 0.00 | 0.01 | 0.4 | 55.63 | n/a |
| sandbox | 695.76 | 2.43 | 2.77 | 4.32 | 992.3 | 222.36 | 245.83 |

- Sandbox vs native p95 overhead: 8325.67x
- Sandbox vs native throughput drop: 99.97%

## echo-json-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 599250.92 | 0.00 | 0.02 | 0.18 | 2.5 | 54.22 | n/a |
| bypass | 1666667.15 | 0.00 | 0.00 | 0.02 | 0.9 | 55.72 | n/a |
| sandbox | 15006.63 | 0.15 | 0.33 | 0.74 | 37.9 | 222.94 | 245.94 |

- Sandbox vs native p95 overhead: 125.76x
- Sandbox vs native throughput drop: 97.50%

## echo-json-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 579570.18 | 0.00 | 0.01 | 0.04 | 2.0 | 54.30 | n/a |
| bypass | 592787.01 | 0.00 | 0.01 | 0.07 | 1.8 | 55.81 | n/a |
| sandbox | 11893.67 | 0.20 | 0.48 | 1.03 | 50.0 | 225.86 | 245.94 |

- Sandbox vs native p95 overhead: 107.03x
- Sandbox vs native throughput drop: 97.95%

## echo-json-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 47610.23 | 0.08 | 0.16 | 0.21 | 20.8 | 54.77 | n/a |
| bypass | 55606.18 | 0.05 | 0.16 | 0.20 | 18.6 | 57.95 | n/a |
| sandbox | 3590.46 | 0.85 | 1.87 | 2.46 | 178.1 | 249.02 | 263.30 |

- Sandbox vs native p95 overhead: 10.73x
- Sandbox vs native throughput drop: 92.46%

## echo-json-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2728.89 | 0.72 | 1.12 | 1.37 | 306.5 | 58.89 | n/a |
| bypass | 2604.10 | 0.79 | 1.03 | 2.23 | 314.6 | 62.06 | n/a |
| sandbox | 469.22 | 3.89 | 6.02 | 20.35 | 1340.9 | 322.94 | 309.38 |

- Sandbox vs native p95 overhead: 5.38x
- Sandbox vs native throughput drop: 82.81%

## mixed-workload

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 887285.28 | 0.00 | 0.00 | 0.33 | 1.7 | 53.23 | n/a |
| bypass | 780944.95 | 0.00 | 0.01 | 0.26 | 1.7 | 55.89 | n/a |
| sandbox | 6888.57 | 1.04 | 1.73 | 3.80 | 90.9 | 155.53 | 163.72 |

- Sandbox vs native p95 overhead: 858.96x
- Sandbox vs native throughput drop: 99.22%


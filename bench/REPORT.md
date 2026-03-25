# Benchmark Report

- Generated: 2026-03-25T16:52:33.688Z
- Profile: full
- Node: v25.7.0
- Runs: 111
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
- `remote-work-200ms`: tiny request/response with about 200 ms of work inside the target, to show how RPC overhead amortizes when useful work dominates.

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
| native | 3035720.40 | 0.00 | 0.00 | 0.33 | 0.4 | 58.80 | n/a |
| bypass | 3148587.23 | 0.00 | 0.00 | 0.35 | 0.4 | 61.03 | n/a |
| sandbox | 26184.05 | 0.07 | 0.13 | 9.72 | 20.4 | 87.69 | n/a |

- Sandbox vs native p95 overhead: 332.19x
- Sandbox vs native throughput drop: 99.14%

## rpc-batch-noop-32

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 14793316.93 | 0.00 | 0.01 | 0.36 | 0.1 | 56.42 | n/a |
| bypass | 15419415.67 | 0.00 | 0.01 | 0.31 | 0.1 | 60.94 | n/a |
| sandbox | 473312.88 | 0.08 | 0.35 | 25.78 | 0.9 | 65.25 | n/a |

- Sandbox vs native p95 overhead: 32.56x
- Sandbox vs native throughput drop: 96.80%

## echo-buffer-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1134215.41 | 0.00 | 0.00 | 0.25 | 1.6 | 51.56 | n/a |
| bypass | 1005446.13 | 0.00 | 0.00 | 0.31 | 1.7 | 54.48 | n/a |
| sandbox | 19185.39 | 0.09 | 0.22 | 0.70 | 36.0 | 61.06 | n/a |

- Sandbox vs native p95 overhead: 75.41x
- Sandbox vs native throughput drop: 98.31%

## echo-buffer-256

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1811662.65 | 0.00 | 0.00 | 0.19 | 0.8 | 52.31 | n/a |
| bypass | 1330438.91 | 0.00 | 0.00 | 0.05 | 1.1 | 54.67 | n/a |
| sandbox | 23926.92 | 0.07 | 0.12 | 0.42 | 24.2 | 61.55 | n/a |

- Sandbox vs native p95 overhead: 250.97x
- Sandbox vs native throughput drop: 98.68%

## echo-buffer-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2744161.17 | 0.00 | 0.00 | 0.05 | 0.4 | 52.31 | n/a |
| bypass | 2284448.20 | 0.00 | 0.00 | 0.08 | 0.4 | 54.67 | n/a |
| sandbox | 23205.56 | 0.07 | 0.12 | 1.97 | 23.6 | 66.06 | n/a |

- Sandbox vs native p95 overhead: 294.10x
- Sandbox vs native throughput drop: 99.15%

## echo-buffer-4096

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2779385.84 | 0.00 | 0.00 | 0.01 | 0.4 | 52.31 | n/a |
| bypass | 2675335.47 | 0.00 | 0.00 | 0.05 | 0.4 | 54.67 | n/a |
| sandbox | 19847.86 | 0.08 | 0.11 | 0.78 | 29.7 | 76.80 | n/a |

- Sandbox vs native p95 overhead: 320.23x
- Sandbox vs native throughput drop: 99.29%

## echo-buffer-16384

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2338232.54 | 0.00 | 0.00 | 0.08 | 1.3 | 55.97 | n/a |
| bypass | 2077173.91 | 0.00 | 0.00 | 0.15 | 1.2 | 57.80 | n/a |
| sandbox | 17863.51 | 0.09 | 0.12 | 0.78 | 35.3 | 110.83 | n/a |

- Sandbox vs native p95 overhead: 357.86x
- Sandbox vs native throughput drop: 99.24%

## echo-buffer-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3015075.36 | 0.00 | 0.00 | 0.05 | 0.3 | 56.50 | n/a |
| bypass | 2568675.13 | 0.00 | 0.00 | 0.11 | 0.5 | 58.77 | n/a |
| sandbox | 7001.46 | 0.21 | 0.49 | 3.61 | 92.9 | 222.97 | n/a |

- Sandbox vs native p95 overhead: 1007.84x
- Sandbox vs native throughput drop: 99.77%

## echo-buffer-262144

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3213213.52 | 0.00 | 0.00 | 0.06 | 0.3 | 56.77 | n/a |
| bypass | 3281673.37 | 0.00 | 0.00 | 0.05 | 0.3 | 58.88 | n/a |
| sandbox | 1879.80 | 0.79 | 2.24 | 10.48 | 379.2 | 231.89 | n/a |

- Sandbox vs native p95 overhead: 3783.07x
- Sandbox vs native throughput drop: 99.94%

## echo-buffer-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2958704.58 | 0.00 | 0.00 | 0.04 | 0.3 | 57.77 | n/a |
| bypass | 3437578.41 | 0.00 | 0.00 | 0.04 | 0.3 | 59.88 | n/a |
| sandbox | 860.87 | 1.80 | 2.77 | 25.85 | 865.0 | 258.94 | n/a |

- Sandbox vs native p95 overhead: 8619.74x
- Sandbox vs native throughput drop: 99.97%

## echo-buffer-4194304

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2401398.14 | 0.00 | 0.00 | 0.07 | 0.6 | 61.88 | n/a |
| bypass | 2640746.33 | 0.00 | 0.00 | 0.04 | 0.6 | 63.97 | n/a |
| sandbox | 276.84 | 4.53 | 16.26 | 70.97 | 2836.0 | 337.44 | n/a |

- Sandbox vs native p95 overhead: 18132.36x
- Sandbox vs native throughput drop: 99.99%

## echo-buffer-10485760

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2744168.66 | 0.00 | 0.00 | 0.04 | 0.5 | 71.89 | n/a |
| bypass | 2544616.44 | 0.00 | 0.00 | 0.08 | 0.4 | 73.98 | n/a |
| sandbox | 111.91 | 11.57 | 32.59 | 58.55 | 6842.7 | 432.38 | n/a |

- Sandbox vs native p95 overhead: 46256.64x
- Sandbox vs native throughput drop: 100.00%

## echo-buffer-16777216

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2687823.64 | 0.00 | 0.00 | 0.04 | 0.5 | 88.02 | n/a |
| bypass | 2879997.80 | 0.00 | 0.00 | 0.02 | 0.4 | 90.09 | n/a |
| sandbox | 74.34 | 19.00 | 41.70 | 107.25 | 10496.8 | 528.59 | n/a |

- Sandbox vs native p95 overhead: 75961.58x
- Sandbox vs native throughput drop: 100.00%

## echo-uint8array-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2325956.32 | 0.00 | 0.00 | 0.06 | 0.7 | 88.17 | n/a |
| bypass | 1934572.91 | 0.00 | 0.00 | 0.02 | 0.9 | 91.38 | n/a |
| sandbox | 21036.50 | 0.09 | 0.14 | 1.33 | 26.7 | 491.80 | n/a |

- Sandbox vs native p95 overhead: 297.81x
- Sandbox vs native throughput drop: 99.10%

## echo-uint8array-256

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2921485.71 | 0.00 | 0.00 | 0.00 | 0.6 | 88.17 | n/a |
| bypass | 2934280.11 | 0.00 | 0.00 | 0.01 | 0.7 | 91.59 | n/a |
| sandbox | 19875.65 | 0.09 | 0.14 | 0.49 | 24.8 | 509.34 | n/a |

- Sandbox vs native p95 overhead: 363.85x
- Sandbox vs native throughput drop: 99.32%

## echo-uint8array-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3075606.10 | 0.00 | 0.00 | 0.05 | 0.5 | 88.20 | n/a |
| bypass | 2640746.33 | 0.00 | 0.00 | 0.06 | 0.7 | 92.52 | n/a |
| sandbox | 22048.62 | 0.07 | 0.12 | 0.86 | 24.5 | 527.44 | n/a |

- Sandbox vs native p95 overhead: 358.11x
- Sandbox vs native throughput drop: 99.28%

## echo-uint8array-4096

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3488796.64 | 0.00 | 0.00 | 0.04 | 0.3 | 88.20 | n/a |
| bypass | 3969673.41 | 0.00 | 0.00 | 0.00 | 0.3 | 92.52 | n/a |
| sandbox | 11310.48 | 0.09 | 0.28 | 11.65 | 29.9 | 548.67 | n/a |

- Sandbox vs native p95 overhead: 429.31x
- Sandbox vs native throughput drop: 99.68%

## echo-uint8array-16384

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3555125.10 | 0.00 | 0.00 | 0.04 | 0.3 | 88.20 | n/a |
| bypass | 3392628.67 | 0.00 | 0.00 | 0.05 | 0.3 | 92.52 | n/a |
| sandbox | 14041.99 | 0.09 | 0.16 | 6.59 | 37.3 | 570.28 | n/a |

- Sandbox vs native p95 overhead: 432.93x
- Sandbox vs native throughput drop: 99.61%

## echo-uint8array-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2669632.43 | 0.00 | 0.00 | 0.11 | 0.6 | 88.25 | n/a |
| bypass | 3821155.43 | 0.00 | 0.00 | 0.01 | 0.4 | 92.52 | n/a |
| sandbox | 8113.15 | 0.19 | 0.61 | 6.86 | 91.2 | 573.80 | n/a |

- Sandbox vs native p95 overhead: 905.60x
- Sandbox vs native throughput drop: 99.70%

## echo-uint8array-262144

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2756776.17 | 0.00 | 0.00 | 0.05 | 0.8 | 88.39 | n/a |
| bypass | 3289177.24 | 0.00 | 0.00 | 0.01 | 0.8 | 92.70 | n/a |
| sandbox | 1937.03 | 0.94 | 1.79 | 17.86 | 345.1 | 423.77 | n/a |

- Sandbox vs native p95 overhead: 3748.09x
- Sandbox vs native throughput drop: 99.93%

## echo-uint8array-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2865671.32 | 0.00 | 0.00 | 0.06 | 0.7 | 88.63 | n/a |
| bypass | 3963664.94 | 0.00 | 0.00 | 0.00 | 0.6 | 92.98 | n/a |
| sandbox | 808.64 | 2.01 | 3.96 | 36.72 | 825.0 | 423.77 | n/a |

- Sandbox vs native p95 overhead: 9615.29x
- Sandbox vs native throughput drop: 99.97%

## echo-uint8array-4194304

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3271241.45 | 0.00 | 0.00 | 0.06 | 0.6 | 88.64 | n/a |
| bypass | 2455032.29 | 0.00 | 0.00 | 0.19 | 1.0 | 92.98 | n/a |
| sandbox | 247.72 | 5.89 | 19.34 | 52.77 | 2860.8 | 496.05 | n/a |

- Sandbox vs native p95 overhead: 35244.73x
- Sandbox vs native throughput drop: 99.99%

## echo-uint8array-10485760

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3705611.10 | 0.00 | 0.00 | 0.04 | 0.3 | 88.64 | n/a |
| bypass | 4340607.80 | 0.00 | 0.00 | 0.00 | 0.2 | 92.98 | n/a |
| sandbox | 104.89 | 13.40 | 32.89 | 78.04 | 6832.3 | 546.16 | n/a |

- Sandbox vs native p95 overhead: 80174.35x
- Sandbox vs native throughput drop: 100.00%

## echo-uint8array-16777216

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3084168.01 | 0.00 | 0.00 | 0.08 | 0.3 | 88.64 | n/a |
| bypass | 3658067.84 | 0.00 | 0.00 | 0.05 | 0.3 | 109.00 | n/a |
| sandbox | 71.59 | 17.94 | 44.48 | 91.65 | 10888.7 | 592.14 | n/a |

- Sandbox vs native p95 overhead: 86303.03x
- Sandbox vs native throughput drop: 100.00%

## echo-json-0

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 583953.24 | 0.00 | 0.00 | 1.41 | 4.0 | 89.17 | n/a |
| bypass | 2051429.90 | 0.00 | 0.00 | 0.03 | 0.9 | 109.11 | n/a |
| sandbox | 18039.56 | 0.07 | 0.09 | 0.73 | 27.4 | 540.17 | n/a |

- Sandbox vs native p95 overhead: 173.96x
- Sandbox vs native throughput drop: 96.91%

## echo-json-256

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1477985.20 | 0.00 | 0.00 | 0.11 | 0.8 | 89.22 | n/a |
| bypass | 1921666.97 | 0.00 | 0.00 | 0.05 | 0.5 | 109.16 | n/a |
| sandbox | 16504.79 | 0.08 | 0.10 | 1.51 | 26.8 | 541.31 | n/a |

- Sandbox vs native p95 overhead: 153.80x
- Sandbox vs native throughput drop: 98.88%

## echo-json-1024

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1516827.19 | 0.00 | 0.00 | 0.05 | 0.7 | 89.22 | n/a |
| bypass | 1342782.07 | 0.00 | 0.00 | 0.04 | 0.8 | 109.16 | n/a |
| sandbox | 16954.68 | 0.09 | 0.11 | 0.18 | 31.5 | 543.56 | n/a |

- Sandbox vs native p95 overhead: 118.78x
- Sandbox vs native throughput drop: 98.88%

## echo-json-4096

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 493083.03 | 0.00 | 0.00 | 0.10 | 2.4 | 89.23 | n/a |
| bypass | 498917.38 | 0.00 | 0.00 | 0.11 | 2.1 | 109.17 | n/a |
| sandbox | 14300.03 | 0.09 | 0.12 | 2.15 | 32.2 | 556.30 | n/a |

- Sandbox vs native p95 overhead: 43.00x
- Sandbox vs native throughput drop: 97.10%

## echo-json-16384

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 249150.03 | 0.01 | 0.03 | 0.05 | 4.0 | 90.72 | n/a |
| bypass | 275671.94 | 0.01 | 0.01 | 0.05 | 3.6 | 109.22 | n/a |
| sandbox | 11146.52 | 0.11 | 0.18 | 7.68 | 52.7 | 610.66 | n/a |

- Sandbox vs native p95 overhead: 16.04x
- Sandbox vs native throughput drop: 95.53%

## echo-json-65536

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 90616.48 | 0.03 | 0.04 | 0.09 | 11.0 | 91.42 | n/a |
| bypass | 90728.67 | 0.02 | 0.04 | 0.07 | 11.0 | 109.33 | n/a |
| sandbox | 6336.06 | 0.20 | 0.46 | 3.20 | 114.2 | 650.31 | n/a |

- Sandbox vs native p95 overhead: 7.15x
- Sandbox vs native throughput drop: 93.01%

## echo-json-262144

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 14747.05 | 0.10 | 0.18 | 0.63 | 66.5 | 93.88 | n/a |
| bypass | 14828.13 | 0.10 | 0.19 | 1.72 | 65.8 | 111.52 | n/a |
| sandbox | 2154.47 | 0.57 | 2.52 | 3.39 | 363.5 | 666.22 | n/a |

- Sandbox vs native p95 overhead: 5.46x
- Sandbox vs native throughput drop: 85.39%

## echo-json-1048576

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 3461.15 | 0.37 | 0.86 | 17.04 | 257.9 | 97.17 | n/a |
| bypass | 3663.80 | 0.36 | 0.91 | 7.15 | 248.0 | 114.80 | n/a |
| sandbox | 679.67 | 1.80 | 4.71 | 5.93 | 1216.2 | 676.39 | n/a |

- Sandbox vs native p95 overhead: 4.86x
- Sandbox vs native throughput drop: 80.36%

## echo-json-4194304

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 901.92 | 1.39 | 3.32 | 30.29 | 1006.1 | 106.22 | n/a |
| bypass | 946.71 | 1.35 | 2.54 | 9.06 | 1005.0 | 138.98 | n/a |
| sandbox | 177.50 | 7.32 | 8.78 | 61.18 | 4607.8 | 732.86 | n/a |

- Sandbox vs native p95 overhead: 5.27x
- Sandbox vs native throughput drop: 80.32%

## echo-json-10485760

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 349.20 | 4.16 | 8.23 | 36.57 | 2606.0 | 137.05 | n/a |
| bypass | 358.44 | 3.94 | 7.14 | 16.49 | 2591.1 | 159.02 | n/a |
| sandbox | 67.58 | 17.95 | 25.93 | 77.50 | 11797.3 | 724.83 | n/a |

- Sandbox vs native p95 overhead: 4.32x
- Sandbox vs native throughput drop: 80.65%

## echo-json-16777216

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 214.87 | 5.76 | 12.16 | 73.02 | 4290.3 | 183.09 | n/a |
| bypass | 220.00 | 5.75 | 12.24 | 36.74 | 4228.1 | 205.06 | n/a |
| sandbox | 42.32 | 33.29 | 65.46 | 93.78 | 17252.8 | 764.58 | n/a |

- Sandbox vs native p95 overhead: 5.78x
- Sandbox vs native throughput drop: 80.30%

## mixed-workload

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 1260316.62 | 0.00 | 0.00 | 0.44 | 1.0 | 56.55 | n/a |
| bypass | 1409960.79 | 0.00 | 0.00 | 0.28 | 0.9 | 60.98 | n/a |
| sandbox | 6855.58 | 1.12 | 1.71 | 35.97 | 96.0 | 207.94 | n/a |

- Sandbox vs native p95 overhead: 1676.40x
- Sandbox vs native throughput drop: 99.46%

## remote-work-200ms

| Mode | ops/sec | p95 ms | p99 ms | max ms | CPU us/op (u+s) | Parent RSS MB | Child RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 4.97 | 201.71 | 201.97 | 202.03 | 202.9 | 49.95 | n/a |
| bypass | 4.98 | 201.36 | 201.51 | 201.55 | 192.2 | 53.61 | n/a |
| sandbox | 4.95 | 202.52 | 202.54 | 202.54 | 397.3 | 55.27 | n/a |

- Sandbox vs native p95 overhead: 1.00x
- Sandbox vs native throughput drop: 0.35%


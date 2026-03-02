export function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return 0;
  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sortedValues[base + 1] ?? sortedValues[base];
  return sortedValues[base] + rest * (next - sortedValues[base]);
}

export function summarizeLatencies(samplesMs) {
  if (samplesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

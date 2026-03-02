# sandboxify

Sandbox selected dependencies in separate Node processes with Node’s Permission Model, while keeping ESM import callsites mostly unchanged.

## Quickstart (Node 25)

Requirements:
- Node `25.x`
- ESM app (`.mjs` or `"type": "module"`) for best compatibility

Install:

```bash
npm install sandboxify
```

Create `sandboxify.policy.jsonc`:

```jsonc
{
  "buckets": {
    "cpu_only": {
      "allowNet": false,
      "allowFsRead": ["./node_modules"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    },
    "fs_ro_templates": {
      "allowNet": false,
      "allowFsRead": ["./node_modules", "./templates"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    }
  },
  "packages": {
    "markdown-it": "cpu_only",
    "handlebars": "cpu_only",
    "nunjucks": "fs_ro_templates"
  }
}
```

Create `register.mjs`:

```js
import { registerHooks } from "node:module";
import { createSandboxHooks } from "sandboxify/loader";

registerHooks(
  createSandboxHooks({
    policyPath: "./sandboxify.policy.jsonc",
    manifestPath: "./.sandboxify/exports.manifest.json"
  })
);
```

Build the export manifest (recommended before run):

```bash
npx sandboxify build-manifest
```

Run your app with the preload hook:

```bash
node --import ./register.mjs ./src/index.mjs
```

## CJS usage (`require` flow)

For CommonJS entrypoints, preload the CJS register:

```bash
node -r sandboxify/register-cjs ./src/index.cjs
```

Local development with this repo layout:

```bash
node -r ./register-cjs.cjs ./src/index.cjs
```

Practical CJS behavior:
- Package selection still follows `sandboxify.policy.jsonc`
- `require("pkg")` returns a sandbox proxy object
- Function exports can be called and return Promises
- Existing ESM flow (`--import .../register.mjs`) is unchanged

How CJS works under the hood (default mode):
1. `register-cjs.cjs` patches `Module._load`.
2. For matched packages, it routes calls to a bucketed sandbox host over IPC.
3. `require("pkg")` returns callable proxy functions.
4. Calling a proxy function performs RPC `load` (once) + RPC `call` (per invocation).
5. Return values are resolved asynchronously (Promise-based CJS API surface).

### Experimental sync-ish CJS calls

For CJS-heavy apps that prefer sync callsites, an experimental mode is available:

```bash
SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1 node -r sandboxify/register-cjs ./src/index.cjs
```

What it does:
- keeps the sandbox process boundary
- attempts synchronous function calls for JSON-compatible and `Buffer` args/returns
- preserves the default async CJS mode when the flag is not set

How `SYNC_EXPERIMENTAL` is achieved:
1. Enable with `SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1`.
2. The CJS loader still intercepts `require`, but function calls are no longer routed to the long-lived async IPC client.
3. Each call is encoded into a strict wire format (JSON + `Buffer` as base64).
4. A blocking broker call executes via `spawnSync` into `src/host/sync-call.js` with the bucket's Node permission flags.
5. The sync host imports the target module, invokes the export, encodes the result, and exits.
6. The caller receives a synchronous return value (or synchronous throw).

Why this is explicitly experimental:
- very high per-call overhead (process spawn + module load + serialization every call)
- only payloads that can be safely encoded/decoded are supported
- intentionally not transparent for complex runtime objects or handles

Caveats (experimental):
- implemented via a blocking per-call sandbox process broker, so latency/throughput are significantly worse than async mode
- only supports function exports whose args/returns are JSON-compatible values or `Buffer`
- unsupported payloads (streams, sockets, class instances, custom prototypes) throw explicit errors
- behavior can change in future releases; do not rely on this for performance-sensitive paths

## Importer-based policy rules (`importerRules`)

In addition to top-level `packages` matching, you can target based on *who imports* a package:

```jsonc
{
  "importerRules": [
    {
      "importer": "file:///app/src/restricted/*",
      "specifier": "sandboxed-lib",
      "bucket": "cpu_only"
    }
  ]
}
```

Rule precedence:
- more specific `specifier` wins
- then more specific `importer` wins
- fallback goes to `packages` mapping

## TypeScript guidance

Recommended setup:
- Compile TS to JS first (`tsc`, swc, esbuild, etc.)
- Run sandboxify against emitted JS (`dist/`), not raw `.ts`
- Build/refresh manifest after install/build changes: `npx sandboxify build-manifest`

Example scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "sandbox:manifest": "sandboxify build-manifest",
    "start:sandbox": "node --import ./register.mjs ./dist/index.js",
    "start:sandbox:cjs": "node -r sandboxify/register-cjs ./dist/index.cjs"
  }
}
```

TS caveats:
- No source-map-level policy matching: policy matches runtime specifiers
- CJS proxy behavior is runtime JS behavior; typings may need local wrappers
- Keep app-side APIs async-friendly when crossing sandbox boundaries

## CLI

Build or refresh manifest:

```bash
npx sandboxify build-manifest
```

Run compatibility checks:

```bash
npx sandboxify doctor
```

`doctor` helps identify packages that need extra permissions (for example addons/process spawning) or are a poor fit for strict RPC mode.

## ESM-first + RPC constraints

`sandboxify` is ESM-first. The default flow uses ESM loader hooks and generated stubs so imports like `import x from "pkg"` stay close to normal.

Sandboxed package calls cross a process boundary, so keep APIs RPC-friendly:
- Prefer structured-cloneable args/returns (plain objects, arrays, strings, numbers, booleans, null, typed arrays)
- Avoid stream/socket/file-handle return types
- Avoid relying on prototype identity (`instanceof`) across boundaries

Batching optimization for hot paths:
- sandboxed function proxies support `fn.batch([[...args], [...args]])`
- this collapses many RPC calls into a single `callMany` request
- ideal when one dependency function is called repeatedly with small payloads

Example:

```js
import { add } from 'sandboxed-lib';

const values = await add.batch([
  [1, 2],
  [3, 4],
  [5, 6]
]);
```

## Explicit limitations (transparency boundaries)

Some fully transparent behavior is impossible with current Node constraints:
- CJS `require()` is synchronous, while sandbox module load/call is RPC and asynchronous
- CJS interception therefore prioritizes callable exports; non-function value exports are not transparently mirrored
- Cross-process identity is not preserved (`instanceof`, class prototypes, symbols tied to realm)
- Native handles (streams, sockets, file descriptors) cannot be passed through RPC as-is
- Side-effect timing may differ because sandboxed module initialization is deferred until first RPC load/call
- Experimental `SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1` mode blocks the caller and uses a high-overhead sync broker per call

Network side effects:
- if a package performs network operations at import-time, `allowNet: false` fails the import immediately
- with `allowNet: true` (Node 25+), that same import-time path can succeed

## Security caveat (important)

Node’s Permission Model is **risk reduction**, not a perfect sandbox. Treat `sandboxify` as a hardening layer for dependencies, not a guarantee against malicious code. Keep Node patched, use least-privilege bucket policies, and consider OS/container isolation for stronger boundaries.

## Debug and bypass

- `SANDBOXIFY_DISABLE=1` disables sandboxing entirely (useful for troubleshooting)
- `SANDBOXIFY_DEBUG=1` enables verbose logs (bucket matching, resolved URLs, sandbox PID, permission denials)

Examples:

```bash
SANDBOXIFY_DEBUG=1 node --import ./register.mjs ./src/index.mjs
SANDBOXIFY_DISABLE=1 node --import ./register.mjs ./src/index.mjs
```

## Benchmarks (MVP)

Run smoke profile locally:

```bash
npm run bench:smoke
```

Run fuller matrix (heavier):

```bash
npm run bench:full
```

The harness compares:
- `native`: direct in-process import/call
- `bypass`: loader path enabled with `SANDBOXIFY_DISABLE=1`
- `sandbox`: full sandbox runtime enabled

It also includes a batched RPC scenario:
- `rpc-batch-noop-<N>` to measure `fn.batch(...)` style amortization of RPC overhead

Outputs:
- JSON: `bench/results/<timestamp>-<profile>.json`
- Latest alias: `bench/results/latest-<profile>.json`
- Summary: `bench/REPORT.md`

## Performance tuning (experimental)

For large binary arguments (`Buffer`/`Uint8Array`), you can enable an IPC blob offload path:

```bash
SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES=262144 node --import ./register.mjs ./src/index.mjs
```

Behavior:
- For `call` RPC arguments above the threshold, runtime writes the binary payload to a temp blob file.
- IPC message sends a lightweight reference object instead of the full bytes.
- Sandbox host reads the blob and replaces it with the original binary value before invoking the export.

Notes:
- Set threshold to `0` to disable offload.
- This currently optimizes **arguments** only (not return payloads).
- Best for request-heavy large-binary call patterns; for tiny payloads, default IPC is usually better.

To view the latest report quickly:

```bash
cat ./bench/REPORT.md
```

Latest smoke result file from this run:
- `bench/results/2026-03-02T15-10-13-815Z-smoke.json`
- Alias: `bench/results/latest-smoke.json`

## Implemented coverage (this repository)

- ESM loader path with manifest-backed static export stubs
- Runtime bucket pools + permissioned sandbox host RPC (`hello/load/call`)
- Policy matcher with package mapping + importer-aware rules (`importerRules`)
- CJS register path:
  - default async proxy mode
  - env-gated sync-like experimental mode
- Integration tests for:
  - successful sandbox call paths (ESM + CJS)
  - denied child process
  - denied/allowed network
  - importer-based routing differences for same dependency
  - import-time side-effect network behavior
- Benchmark harness with `native` / `bypass` / `sandbox` comparisons and markdown+json output
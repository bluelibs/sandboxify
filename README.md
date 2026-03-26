# sandboxify

Sandbox selected Node dependencies in separate processes using Node's Permission Model, while keeping your app's import sites close to normal.

`sandboxify` lets you decide which packages run in a restricted child process and what they can access: network, filesystem, child processes, workers, addons, and more.

Requirements:

- Node `25.x`
- ESM app (`.mjs` or `"type": "module"`) for the smoothest experience

## Why sandboxify?

- Reduce the blast radius of third-party dependencies.
- Keep policy decisions out of app code and in one JSONC file.
- Preserve a familiar import-and-call workflow for function-oriented libraries.
- Apply least-privilege rules per package or per importer path.
- Keep a practical escape hatch with debug and bypass modes.

## Best Fit

`sandboxify` shines with function-oriented dependencies: packages that accept plain data and return plain data.

Great candidates:

- sanitizers, parsers, formatters, and helper libraries
- compute-heavy or medium-latency dependency work
- hot paths where the same function can be batched

Poor candidates:

- constructor-heavy libraries that expect fully transparent in-process instances
- exported objects with methods
- streams, sockets, file handles, and other native handles
- packages that depend on shared in-process identity or mutable globals

> `sandboxify` is a hardening layer, not a perfect VM boundary. Use least privilege, keep Node patched, and add OS or container isolation when you need stronger containment.

## Quickstart (ESM)

This example uses `sanitize-html` because it exports a plain function and returns plain data, which is exactly the shape `sandboxify` likes.

Install:

```bash
npm install sandboxify sanitize-html
```

Create `sandboxify.policy.jsonc`:

```jsonc
{
  "buckets": {
    "html_only": {
      "allowNet": false,
      "allowFsRead": ["./node_modules"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    }
  },
  "packages": {
    "sanitize-html": "html_only"
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
    manifestPath: "./.sandboxify/exports.manifest.json",
  }),
);
```

Create `src/index.mjs`:

```js
import sanitizeHtml from "sanitize-html";

const dirty = `
  <p>Hello <strong>world</strong> <script>alert("nope")</script></p>
`;

const clean = await sanitizeHtml(dirty, {
  allowedTags: ["p", "strong", "em", "a"],
});

console.log(clean);
```

Build the manifest:

```bash
npx sandboxify build-manifest
```

Run your app:

```bash
node --import ./register.mjs ./src/index.mjs
```

Important:

- Sandboxed function exports are async, even if the original library function was synchronous.
- The manifest is strongly recommended and effectively required for named ESM imports, because loader stubs need to know export names ahead of time.
- Rebuild the manifest after dependency installs, upgrades, or export-surface changes.

## How It Works

1. The loader matches an import against `sandboxify.policy.jsonc`.
2. For matching packages, it serves a generated ESM stub instead of importing the dependency directly.
3. The stub talks to a per-bucket sandbox host process started with Node permission flags.
4. Function calls cross the process boundary over RPC, and results come back as structured-cloneable values.

## Mental Model

- Function exports become async call proxies.
- Constructable exports can be instantiated with async construction: `const instance = await new Thing(...)`.
- Function proxies also expose `fn.batch(argsList)` for high-frequency hot paths.
- Constructed remote instances support async method calls and plain own-field snapshots after construction and method calls.
- Plain cloneable value exports can be loaded once and used as values.
- Unsupported shapes still stay unsupported: streams, sockets, complex realm-bound objects, and fully transparent live object graphs are not a fit.
- Import-time side effects still happen inside the sandbox and must obey the bucket's permissions.

## Class Example

Class exports are supported, but construction is async across the process boundary:

```js
import { Counter } from "some-class-lib";

const counter = await new Counter(2);
console.log(counter.value);

console.log(await counter.increment(3));
console.log(counter.value);
```

This works best when:

- constructor args are structured-cloneable
- instance methods return structured-cloneable values
- instance state is plain data on the instance itself

This works less well when the class relies on:

- static methods or static mutable state
- property writes from the caller side
- `instanceof`, custom prototypes, or identity-sensitive behavior
- native handles or event-emitter style live objects

## Batch Example

If you call the same sandboxed function repeatedly, batch it:

```js
import sanitizeHtml from "sanitize-html";

const results = await sanitizeHtml.batch([
  ["<p>first<script>bad()</script></p>"],
  [
    '<a href="https://example.com" onclick="nope()">link</a>',
    {
      allowedTags: ["a"],
      allowedAttributes: { a: ["href"] },
    },
  ],
  ["<strong>third</strong>"],
]);
```

This collapses many logical calls into one RPC `callMany` request and is usually the single biggest performance win for chatty workloads.

## Policy Reference

Each package maps to a bucket, and each bucket describes what the sandboxed process may do.

| Key | Type | Meaning |
| --- | --- | --- |
| `allowNet` | `boolean` | Allow network access from the sandboxed dependency. |
| `allowFsRead` | `string[] \| "*"` | Allow reads from these paths. Relative paths are resolved from your app cwd. |
| `allowFsWrite` | `string[] \| "*"` | Allow writes to these paths. |
| `allowChildProcess` | `boolean` | Allow child process creation. |
| `allowWorker` | `boolean` | Allow `Worker` usage. |
| `allowAddons` | `boolean` | Allow native addons. |
| `allowWasi` | `boolean` | Allow WASI. |
| `allowInspector` | `boolean` | Allow inspector APIs. |
| `env` | `Record<string, string>` | Extra env vars merged into the sandbox process. |

Notes:

- `packages` supports exact matches and simple wildcard suffixes like `"@acme/render-*": "renderers"`.
- `importerRules` lets you route the same dependency to different buckets depending on who imported it.
- `allowFsRead` should usually include `./node_modules` for the package being sandboxed.

## Importer Rules

Use `importerRules` when the same dependency should get different permissions depending on the importing module.

```jsonc
{
  "buckets": {
    "restricted_net": {
      "allowNet": false,
      "allowFsRead": ["./node_modules"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    },
    "open_net": {
      "allowNet": true,
      "allowFsRead": ["./node_modules"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    }
  },
  "packages": {
    "some-http-lib": "restricted_net"
  },
  "importerRules": [
    {
      "importer": "file:///app/src/open/*",
      "specifier": "some-http-lib",
      "bucket": "open_net"
    }
  ]
}
```

Rule precedence:

- more specific `specifier` wins
- then more specific `importer` wins
- fallback goes to `packages`

## CommonJS (`require`) Usage

Preload the CJS register:

```bash
node -r sandboxify/register-cjs ./src/index.cjs
```

Inside this repo during local development:

```bash
node -r ./register-cjs.cjs ./src/index.cjs
```

Example:

```js
const sanitizeHtml = require("sanitize-html").default;

(async () => {
  const clean = await sanitizeHtml("<p>Hello<script>bad()</script></p>");
  console.log(clean);
})();
```

What to expect:

- `require("pkg")` returns a proxy object, not a perfectly transparent clone of the original module.
- Function exports still work well and return Promises in default mode.
- Constructable exports can be used with async construction: `const value = await new ExportedClass(...)`.
- The CJS path is still function-first; non-function values are not transparently mirrored.

### Experimental sync-ish CJS mode

```bash
SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1 node -r sandboxify/register-cjs ./src/index.cjs
```

This mode:

- keeps the sandbox process boundary
- tries to preserve synchronous call sites for JSON-compatible and `Buffer` args and returns
- is much slower per call because it uses a blocking broker process

Use it only when CJS compatibility matters more than performance.

## TypeScript

Recommended setup:

- compile TypeScript to JavaScript first
- run `sandboxify` against emitted JS in `dist/`
- rebuild the manifest after install or build changes

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

Notes:

- policy matching happens on runtime specifiers, not source maps
- keep app-side boundaries async-friendly
- if you rely on named ESM imports, regenerate the manifest when exports change

## CLI

Build or refresh the manifest:

```bash
npx sandboxify build-manifest
```

Run basic checks:

```bash
npx sandboxify doctor
```

CLI options:

- `--policy <path>`: policy JSON or JSONC path
- `--manifest <path>`: manifest path

What `build-manifest` does:

- resolves packages matched by your policy
- imports them once to discover export names
- writes `./.sandboxify/exports.manifest.json`

Why it matters:

- valid ESM stubs need to know export names ahead of time
- stale manifests are a common reason named imports drift or fail

## Debugging and Bypass

Useful env vars:

| Env var | Purpose |
| --- | --- |
| `SANDBOXIFY_DISABLE=1` | Disable sandboxing entirely. Great for isolating policy vs app bugs. |
| `SANDBOXIFY_DEBUG=1` | Print loader and runtime debug logs. |
| `SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1` | Enable sync-ish CJS mode. |
| `SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES=<n>` | Offload large `Buffer` or `Uint8Array` arguments to temp blob files before RPC. |
| `SANDBOXIFY_POLICY_PATH=<path>` | Override the default policy path. |
| `SANDBOXIFY_MANIFEST_PATH=<path>` | Override the default manifest path. |

Examples:

```bash
SANDBOXIFY_DEBUG=1 node --import ./register.mjs ./src/index.mjs
SANDBOXIFY_DISABLE=1 node --import ./register.mjs ./src/index.mjs
SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES=262144 node --import ./register.mjs ./src/index.mjs
```

Common gotchas:

- Named ESM imports missing or wrong: rebuild the manifest.
- Permission denial at import time: the dependency does work during module initialization, not just during function calls.
- Weird class or prototype behavior: wrap that dependency behind your own plain-data adapter instead of sandboxing it directly.

## Performance Notes

`sandboxify` adds real process-boundary overhead, so use it where the security tradeoff makes sense.

Practical rules:

- The smaller the call, the more visible the overhead.
- The chunkier the dependency work, the less the sandbox tax matters.
- Batching is the best lever for repeated small calls.
- Large binary arguments can benefit from `SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES`.
- The blob offload path currently helps arguments, not return payloads.
- Return values are best kept plain and reasonably sized.

Benchmarks in this repo:

```bash
npm run bench:smoke
npm run bench:full
```

Outputs:

- JSON: `bench/results/<timestamp>-<profile>.json`
- latest alias: `bench/results/latest-<profile>.json`
- markdown summary: `bench/REPORT.md`

## Limitations

Current transparency boundaries:

- sandboxed function exports are async in the default ESM and CJS flow
- class exports use async construction (`await new ExportedClass(...)`) and are not fully transparent
- exported objects with methods are usually a poor fit unless you wrap them as plain functions
- streams, sockets, file handles, and other native handles do not cross the RPC boundary intact
- cross-process identity is not preserved (`instanceof`, prototypes, realm-bound symbols)
- module side-effect timing can shift because sandbox loading is deferred until the first sandbox interaction
- caller-side property writes and static class behavior are not synchronized across the boundary
- experimental sync CJS mode is intentionally high overhead

## Security Caveat

Node's Permission Model is risk reduction, not a perfect sandbox. Treat `sandboxify` as a dependency hardening layer, not a full isolation guarantee. Keep Node patched, use least-privilege bucket policies, and add OS or container isolation when the threat model demands it.

# sandboxify

Run selected dependencies in a restricted Node child process, while keeping your app code close to normal.

`sandboxify` is for the moment when you trust a dependency enough to use it, but not enough to let it run with your app's full permissions.

With one policy file, you can decide:

- which packages should run in a sandbox
- whether they can use the network
- what filesystem paths they can read or write
- whether they can spawn child processes, workers, addons, and more

## What This Is

Think of `sandboxify` as a dependency hardening layer for Node.

It intercepts selected imports, runs those dependencies in a separate process with Node permission flags, and proxies function calls across that boundary.

That gives you a useful middle ground:

- safer than running every dependency directly in your app
- lighter-weight than rewriting your app around workers or a custom RPC layer
- more practical than pretending every dependency deserves full trust

## Who This Is For

`sandboxify` works best when the dependency API stays understandable across a process boundary.

Good fits:

- HTML sanitizers
- parsers and formatters
- markdown or template helpers
- utility libraries with data-in/data-out APIs
- object-oriented libraries that mostly interact through methods and ordinary properties
- heavier dependency work where a little RPC overhead is acceptable

Less ideal fits:

- streams, sockets, file handles, and native resources
- code that depends on `instanceof`, shared in-process identity, or mutable globals
- packages that expect perfectly transparent class behavior

Class and object exports are supported, but not perfectly transparently:

- construction is async: `const instance = await new MyClass(...)`
- instance and object methods work over RPC
- ordinary properties can be read and passed back into other sandboxed calls
- mutation through methods works in the sandboxed object
- direct caller-side property writes do not sync back
- `instanceof` and full prototype identity do not survive the process boundary

## Before You Start

Requirements:

- Node `25.x`
- ESM is the recommended path

Important expectations:

- sandboxed calls are async, even if the original library looked synchronous
- this is a hardening layer, not a perfect security boundary
- you should still use least-privilege policies and keep Node patched

## 5-Minute Setup

This example uses `sanitize-html`, which is a great fit for `sandboxify`.

### 1. Install

```bash
npm install sandboxify sanitize-html
```

### 2. Create a policy

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

### 3. Register the loader

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

### 4. Write normal-looking app code

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

### 5. Build the manifest

```bash
npx sandboxify build-manifest
```

### 6. Run your app

```bash
node --import ./register.mjs ./src/index.mjs
```

## What Changes In My Code?

Usually, less than you think.

Your import can stay familiar:

```js
import sanitizeHtml from "sanitize-html";
```

The main behavior change is that sandboxed calls are async:

```js
const clean = await sanitizeHtml(html);
```

If the library exports a class:

```js
import { Counter } from "some-class-lib";

const counter = await new Counter(2);
console.log(await counter.increment(3));
```

That async construction is not an ESM thing. It is a process-boundary thing.

## What Happens Under The Hood?

1. `sandboxify` checks whether an import matches your policy.
2. If it does, it replaces the original import with a generated stub.
3. That stub talks to a sandbox host process for the matching bucket.
4. Calls cross the process boundary over RPC.
5. Results come back as cloneable values or remote object handles, depending on the export shape.

You still write app code. `sandboxify` handles the transport layer.

## The Mental Model

If you keep this model in your head, the package feels much less surprising:

- function exports become async call proxies
- `fn.batch(argsList)` is available for repeated calls to the same function
- class construction becomes async: `await new MyClass(...)`
- object and instance methods work, but they are remote calls
- plain values stay plain when they are structured-cloneable
- object-shaped exports can come back as remote handles instead of cloned data
- identity-sensitive behavior does not stay transparent across processes

Good question to ask yourself:

> "If I had to call this dependency over RPC, would the API still make sense?"

If the answer is yes, `sandboxify` is probably a good fit.

## Common Usage Patterns

### Function-based dependency

```js
import parse from "some-parser";

const result = await parse(input);
```

### Batch repeated calls

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

Batching is often the biggest performance win when a sandboxed function is called frequently.

### Local file dependency

You can sandbox a local file too, not just packages from `node_modules`.

For local-looking entries, `packages` matches the file itself, not just one exact relative spelling.
That means a policy entry like `./src/pdf-service.mjs` still applies if another module reaches the same file through `../app/src/pdf-service.mjs`.
Literal raw matches still win if you deliberately configure both.

Policy:

```jsonc
{
  "buckets": {
    "local_cpu": {
      "allowNet": false,
      "allowFsRead": ["./local-libs"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false
    }
  },
  "packages": {
    "./local-libs/file-sandboxed-lib.mjs": "local_cpu"
  }
}
```

App code:

```js
import { multiply } from "./local-libs/file-sandboxed-lib.mjs";

console.log(await multiply(3, 4));
```

Equivalent import from somewhere else:

```js
import { multiply } from "../app/local-libs/file-sandboxed-lib.mjs";

console.log(await multiply(3, 4));
```

Both imports resolve to the same file, so both land in the same sandbox bucket.

## Policy Basics

Your policy has two main parts:

- `buckets`: what permissions a sandbox gets
- `packages`: which dependency goes into which bucket
  For package names this matches the package name and its subpaths.
  For local file specifiers it matches the raw specifier first, then the resolved file URL as a fallback.
  `packages` is also the canonical ownership map: one dependency belongs to one bucket.

Example:

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
    }
  },
  "packages": {
    "sanitize-html": "cpu_only"
  }
}
```

### Bucket keys

| Key | Meaning |
| --- | --- |
| `allowNet` | Allow network access. |
| `allowFsRead` | Allow filesystem reads from these paths. |
| `allowFsWrite` | Allow filesystem writes to these paths. |
| `allowChildProcess` | Allow spawning child processes. |
| `allowWorker` | Allow `Worker` usage. |
| `allowAddons` | Allow native addons. |
| `allowWasi` | Allow WASI. |
| `allowInspector` | Allow inspector APIs. |
| `env` | Add environment variables to the sandbox process. |

### Policy tips

- include `./node_modules` in `allowFsRead` for sandboxed packages
- include local directories too if you sandbox local file dependencies
- bare package entries in `packages` also cover package subpaths like `pkg/sub/path.js`
- local file entries in `packages` use raw specifier matching first, then resolved-file fallback
- packages in the same bucket import each other natively inside that sandbox host
- imports from one bucket into another bucket bridge over RPC to the target bucket
- cross-bucket bridging currently needs `allowChildProcess: true` on the bucket that initiates the bridge
- cross-bucket circular import chains are not supported
- start restrictive and open only what a dependency really needs
- JSONC is supported so you can leave comments in the policy

## Advanced Policy: Importer Rules

Use `importerRules` when you need to sandbox something that is not canonically owned by `packages`, or when you want importer-based handling for local-file-only cases.

That is what `importerRules` is for.

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
    "other-http-lib": "restricted_net"
  },
  "importerRules": [
    {
      "importer": "file:///app/src/open/*",
      "specifier": "some-special-case-lib",
      "bucket": "open_net"
    }
  ]
}
```

Rule precedence:

- `packages` is authoritative for canonical bucket ownership
- more specific `specifier` wins
- then more specific `importer` wins
- fallback goes to no match if `packages` did not already claim the specifier
- raw specifier matches win over resolved-file fallback matches
- conflicting `importerRules` that try to remap a `packages` entry are rejected

## ESM vs CJS

If you can choose, use ESM.

ESM is the primary path:

- cleaner import behavior
- better fit with generated loader stubs
- the smoothest user experience

CJS exists as a compatibility path:

- preload with `node -r sandboxify/register-cjs`
- default CJS mode is still async at call time
- the CJS path is more function-first and less transparent overall

Example:

```bash
node -r sandboxify/register-cjs ./src/index.cjs
```

```js
const sanitizeHtml = require("sanitize-html").default;

(async () => {
  const clean = await sanitizeHtml("<p>Hello<script>bad()</script></p>");
  console.log(clean);
})();
```

Experimental sync-ish CJS mode also exists:

```bash
SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1 node -r sandboxify/register-cjs ./src/index.cjs
```

Use that only when you really need sync call sites and can tolerate much higher overhead.

## TypeScript

Recommended flow:

1. compile TypeScript to JavaScript
2. run `sandboxify` against the emitted JS
3. rebuild the manifest after install or build changes

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

## CLI

Build or refresh the manifest:

```bash
npx sandboxify build-manifest
```

Run a quick setup check:

```bash
npx sandboxify doctor
```

Useful options:

- `--policy <path>`
- `--manifest <path>`

## Why The Manifest Exists

The manifest records export names for sandboxed modules.

That matters because the ESM stub generator needs to know which exports to expose ahead of time.

Practical takeaway:

- build the manifest before running
- rebuild it after dependency installs or upgrades
- rebuild it if a sandboxed package's exports changed

## Debugging

Useful environment variables:

| Env var | Purpose |
| --- | --- |
| `SANDBOXIFY_DISABLE=1` | Disable sandboxing entirely. |
| `SANDBOXIFY_DEBUG=1` | Print loader and runtime debug logs. |
| `SANDBOXIFY_CJS_SYNC_EXPERIMENTAL=1` | Enable sync-ish CJS mode. |
| `SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES=<n>` | Offload large `Buffer` and `Uint8Array` arguments to temp files before RPC. |
| `SANDBOXIFY_POLICY_PATH=<path>` | Override the policy path. |
| `SANDBOXIFY_MANIFEST_PATH=<path>` | Override the manifest path for both the app loader and nested sandbox-to-sandbox bridging. |

Examples:

```bash
SANDBOXIFY_DEBUG=1 node --import ./register.mjs ./src/index.mjs
SANDBOXIFY_DISABLE=1 node --import ./register.mjs ./src/index.mjs
SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES=262144 node --import ./register.mjs ./src/index.mjs
```

If something feels off, the most common fixes are:

- rebuild the manifest
- confirm the import actually matches your policy
- confirm the sandbox has filesystem access to the dependency path
- temporarily run with `SANDBOXIFY_DISABLE=1` to separate app issues from sandbox issues

## Testing

`sandboxify` usually fits best in integration-style tests, not every single unit test.

Practical rule of thumb:

- keep fast unit tests mostly unsandboxed
- use sandboxed integration tests for the real permission and RPC behavior
- if you use TypeScript, compile first and test the emitted JavaScript

### Unit tests

For ordinary unit tests, you often do not need the sandbox at all.

That keeps the tests simpler and avoids process-boundary overhead when you are only checking app logic.

Options:

- do not preload `sandboxify` in those tests
- or set `SANDBOXIFY_DISABLE=1`

Example:

```bash
SANDBOXIFY_DISABLE=1 node --test
```

### Integration tests

For tests that should verify the real sandbox behavior, use the same flow as production:

1. build your app if needed
2. build or refresh the manifest
3. run the test target with the loader or CJS register enabled

ESM example:

```bash
npx sandboxify build-manifest
node --import ./register.mjs ./dist/integration/sanitize-html.test.js
```

CJS example:

```bash
npx sandboxify build-manifest
node -r sandboxify/register-cjs ./dist/integration/sanitize-html.test.cjs
```

Those tests exercise the full path:

- import interception
- generated stubs
- sandbox host startup
- permission enforcement
- RPC calls across the process boundary

### TypeScript test flow

If your app or tests are written in TypeScript, the recommended flow is still:

1. compile TypeScript to JavaScript
2. build the manifest against the emitted files
3. run tests against the emitted files

Example scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test ./dist/**/*.test.js",
    "test:sandbox": "npm run build && sandboxify build-manifest && node --import ./register.mjs ./dist/integration/app.test.js"
  }
}
```

If you sandbox local files, make sure your policy matches the emitted runtime files like `./dist/pdf-service.js`, not the original source files like `./src/pdf-service.ts`.

### When to rebuild the manifest in tests

Rebuild the manifest when:

- you changed the build output
- you changed which packages are sandboxed
- you changed a sandboxed package version
- a sandboxed module's exports changed

If a sandboxed test suddenly fails in a strange way, rebuilding the manifest is one of the highest-leverage first checks.

## Performance

`sandboxify` adds process-boundary overhead. That is normal.

Practical rules of thumb:

- tiny calls feel the overhead more
- chunky dependency work hides the overhead better
- batching helps a lot for repeated small calls
- large binary arguments can benefit from `SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES`
- blob offload currently helps arguments, not return values

Benchmarks in this repo:

```bash
npm run bench:smoke
npm run bench:full
```

Outputs:

- `bench/results/<timestamp>-<profile>.json`
- `bench/results/latest-<profile>.json`
- `bench/REPORT.md`

## Limitations

These are the important limits to understand before adopting `sandboxify`:

- sandboxed calls are async by default
- class support is partial, not fully transparent
- `instanceof` does not survive the process boundary
- caller-side property writes do not sync back to remote objects or instances
- static class behavior is not synchronized across the boundary
- exported objects with methods are supported, but still carry process-boundary semantics
- streams, sockets, file handles, and similar native handles do not cross the boundary intact
- module side effects still happen, and they still need the right permissions

## Security Notes

Node's Permission Model reduces risk. It does not create a perfect sandbox.

Treat `sandboxify` as:

- strong dependency hardening
- useful blast-radius reduction
- a practical least-privilege tool

Do not treat it as:

- a complete isolation boundary
- a guarantee against malicious code
- a replacement for OS-level or container isolation when you need stronger guarantees

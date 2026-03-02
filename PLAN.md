## Objective

Provide **per-dependency (or per-import-specifier) sandboxing** for selected `node_modules` by running those dependencies inside **separate OS processes** with **Node’s Permission Model**, while keeping application code changes close to zero for **ESM imports**.

The core approach is:

**policy buckets → sandbox process pools (least-privilege Node processes) → module-resolution/loading hooks that replace imports with RPC-backed proxy modules**

This design intentionally treats many dependencies as **“library-as-a-service”**: you call exported functions across an IPC boundary; the sandboxed code cannot freely touch FS/network/child_process/etc unless its bucket allows it.

---

## Reality checks (constraints from Node)

### Permission Model scope and limitations

- Node’s Permission Model is **process-based**, enabled via `--permission`, and restricts access to resources like FS, child processes, worker threads, native addons, WASI, inspector, etc. ([Node.js][1])
- It is explicitly described by Node as a **“seat belt”**: it **does not provide security guarantees against malicious code** and has known bypass categories. ([Node.js][1])
- Permissions **do not inherit to worker threads** (so you need OS processes for real isolation). ([Node.js][1])
- There are important known issues:
  - **Symlinks are followed** even outside allowed paths; allowed-path trees must not contain relative symlinks. ([Node.js][1])
  - **Existing file descriptors can bypass** FS restrictions if passed into the sandbox. ([Node.js][1])

### Network permission is version-gated

- In Node **v24 LTS**, Permission Model docs do **not** list network restriction/allowance. ([Node.js][2])
- Node **v25** adds `--allow-net` (so network control via Permission Model becomes practical there). ([Node.js][3])

### Loader hooks API choice

- Node provides **module customization hooks**:
  - `module.registerHooks()` with synchronous in-thread hooks (release candidate). ([Node.js][4])
  - `module.register()` with asynchronous hooks on a loader thread (active development with caveats). ([Node.js][4])

- The CLI docs discourage `--experimental-loader` in favor of `--import` with registration. ([Node.js][3])

**Implication for your design:**
Your “load hook asks sandbox for export list then generates ESM re-export stub” is easiest with **async hooks**, but you can get production-grade stability by using **sync hooks + an export manifest** (details below).

---

## Target developer experience (DX)

### Goal DX

- Keep callsites unchanged for ESM:

```js
import MarkdownIt from "markdown-it"; // sandboxed, looks normal
```

- Policies live in one file and are understandable:

```jsonc
// sandboxify.policy.jsonc
{
  "buckets": {
    "cpu_only": {
      "allowNet": false,
      "allowFsRead": ["./node_modules"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false,
    },
    "fs_ro_templates": {
      "allowNet": false,
      "allowFsRead": ["./node_modules", "./templates"],
      "allowFsWrite": [],
      "allowChildProcess": false,
      "allowWorker": false,
      "allowAddons": false,
    },
  },
  "packages": {
    "markdown-it": "cpu_only",
    "handlebars": "cpu_only",
    "nunjucks": "fs_ro_templates",
  },
}
```

- App starts with one extra flag:

```bash
node --import ./node_modules/sandboxify/register.mjs ./src/index.mjs
```

Node supports registering hooks before app code runs using `--import` (and similarly `--require` for CJS). ([Node.js][4])

### “No surprises” rules

- If a package is sandboxed, it must follow **RPC-friendly constraints** (structured-cloneable args/returns) unless you enable an “object-reference” mode (less transparent).
- Clear error messages:
  - “Denied by bucket policy: network not allowed”
  - “Export shape not supported (streams/functions/classes)”
  - “Package uses native addons but bucket disallows --allow-addons”

- Opt-out switches:
  - `SANDBOXIFY_DISABLE=1` disables all sandboxing (useful for debugging).
  - `SANDBOXIFY_BUCKET_OVERRIDES=...` for local experimentation.

---

## High-level architecture

### Components

1. **Policy layer**
   - Loads policy config (JSON/JSONC/YAML).
   - Resolves specifier → bucket.
   - Normalizes paths, ensures allowlists are absolute/realpathed when possible.

2. **Loader layer (main process)**
   - Registers `resolve` and `load` hooks.
   - If an import specifier is sandboxed:
     - Resolve returns a synthetic URL for a generated stub module.
     - Load returns the **source text** for that stub module.

3. **Runtime (main process)**
   - Manages a **process pool per bucket**.
   - Provides `getRemoteModule(bucket, resolvedUrl, exportNames, options)`.

4. **Sandbox host (child process)**
   - Started with `node --permission ...` and minimal `--allow-*`.
   - Imports the real target module.
   - Exposes RPC endpoints: load module, list exports, invoke export, (optional) object refs.

5. **RPC protocol**
   - Message-based over Node IPC (child process `ipc` channel).
   - Correlation IDs, structured clone payloads, typed errors.

---

## Supported Node versions (recommended stance)

You want this to be predictable. Recommended:

- **Minimum:** Node **v22.15+** for `module.registerHooks` availability. ([Node.js][4])
- **Network restriction buckets require:** Node **v25+** because `--allow-net` is added in v25. ([Node.js][3])
- If running on Node v24 LTS:
  - You still get FS/child_process/worker/addons/WASI/inspector controls, but **not reliable network sandboxing** via Permission Model. ([Node.js][2])
  - If you must restrict network on v24, treat it as an **OS-level concern** (container, firewall, seccomp) rather than Node flags.

---

## Policy spec

### Policy file schema

**Top-level**

- `buckets: Record<string, BucketDefinition>`
- `packages: Record<string, string>` mapping **package names or patterns** → bucket name
- optional:
  - `defaults`: global settings, export rules
  - `overrides`: per-environment overrides (dev/test/prod)

**BucketDefinition**

- `allowFsRead: string[] | false | "*"`
- `allowFsWrite: string[] | false | "*"`
- `allowNet: boolean | string[]`
  - boolean for Node v25+ simple allow/deny
  - future: host allowlist (if Node adds it; otherwise OS-level)

- `allowChildProcess: boolean`
- `allowWorker: boolean`
- `allowAddons: boolean`
- `allowWasi: boolean`
- `allowInspector: boolean`
- `env: Record<string,string>` (env injected into sandbox only)
- `limits`:
  - `maxProcs` per bucket
  - `maxConcurrency` per proc
  - `idleTtlMs` before recycling
  - `maxHeapMb` (implemented via `--max-old-space-size` on sandbox)
  - `cpuTimeoutMs` per RPC call (enforced by host watchdog)

**Package mapping**

- Keys support:
  - exact package: `"markdown-it"`
  - subpath patterns: `"lodash/*"`, `"date-fns/*"`
  - optional glob: `"@scope/*"`

- Resolution rule:
  - Match longest/most-specific rule.
  - If multiple matches, deterministic tie-break (e.g., exact > glob).

---

## Loader + stub generation design

### Why a manifest is important (sync hooks constraint)

`module.registerHooks()` hooks are synchronous. ([Node.js][4])
If you need export lists to generate static ESM exports, you can’t “await sandbox” inside the hook.

**Solution:** maintain an **Export Manifest**:

- Keyed by **resolved module URL** (or package name + version + export condition set).
- Value is `exportNames: string[]` and metadata (default export present, etc).

You can populate it via:

1. **Build step** (recommended): `sandboxify build-manifest`
2. **Lazy “first run”**: if missing, do a blocking `spawnSync` inspect (acceptable for dev, not ideal for prod)

### Hooks behavior

#### resolve(specifier, context, nextResolve)

- If `specifier` is not policy-mapped → `return nextResolve(specifier, context)`
- If sandboxed:
  1. Call `nextResolve(specifier, context)` to get the real `url` (do not load, just resolve)

  2. Create a synthetic URL like:

     `sandboxify:bucket=<bucket>&id=<hash(realUrl)>`

  3. Store mapping: `id -> { bucket, realUrl, specifier, context.conditions }`

  4. Return `{ url: syntheticUrl, shortCircuit: true }` ([Node.js][4])

#### load(url, context, nextLoad)

- If `url` is not `sandboxify:` → `return nextLoad(url, context)`
- Else:
  1. Decode `bucket` + `id`
  2. Lookup `realUrl`
  3. Fetch `exportNames` from manifest (sync read / in-memory cache)
  4. Generate ESM stub source:
     - uses top-level await
     - obtains remote module proxy
     - exports default + named exports as static declarations

  5. Return `{ format: 'module', source: <string>, shortCircuit: true }` ([Node.js][4])

### Generated ESM stub (canonical form)

Example output:

```js
// sandboxify stub
import { getRemoteModule } from "sandboxify/runtime";

const m = await getRemoteModule({
  bucket: "cpu_only",
  specifier: "markdown-it",
  url: "file:///.../node_modules/markdown-it/index.mjs",
  exportNames: ["default", "Renderer", "Token"],
});

export default m.default;
export const Renderer = m.Renderer;
export const Token = m.Token;
```

Notes:

- `export const X = m.X` is not a “live binding” to a remote value; it snapshots at init. In practice, exports are rarely mutated.
- `m.X` must be callable/value-like under your proxy rules.

### What about re-exporting types?

At runtime you redirect imports, but TypeScript typechecking resolves packages normally. For most setups:

- **No TS changes needed** (types still come from the real package).
- If you generate on-disk stubs, ensure they are **not** on TS resolution paths (don’t add them to `typesVersions` or `paths` unless you also generate `.d.ts` passthroughs).

---

## Sandbox pool design

### Spawning

Use `child_process.spawn()` (not `fork()` by default) to avoid unexpected argument inheritance.

Reason: Node documents that with Permission Model enabled and `--allow-child-process`, `fork()` will inherit relevant Permission Model flags automatically. ([Node.js][3])
You want explicit, least-privilege flags per bucket.

**Sandbox process command template**

```txt
node
  --permission
  --allow-fs-read=<path>  (repeatable)
  --allow-fs-write=<path> (repeatable)
  --allow-net             (Node v25+ only; omit if disallowed)
  --allow-worker          (only if needed)
  --allow-child-process   (strongly discouraged)
  --allow-addons          (only if needed)
  --allow-wasi            (only if needed)
  --allow-inspector       (only if debugging)
  <sandbox-host-entry>
```

Flags and behaviors are defined in Node docs. ([Node.js][1])

### Pool semantics

Per bucket:

- Maintain `N` processes (configurable).
- Each process has:
  - a request queue
  - an “in-flight” counter
  - module cache (in the sandbox)

Process lifecycle:

- Start on demand.
- Health-check handshake: host sends `ready` + version + capabilities.
- Recycle on:
  - crash / non-zero exit
  - memory watermark exceeded
  - idle TTL exceeded
  - protocol mismatch

### Deterministic module identity

Inside each sandbox process:

- Cache modules by `realUrl` (or canonical key).
- If two different sandboxed imports resolve to different `realUrl`s, they are treated as different modules.

---

## Sandbox host behavior

### Responsibilities

- Receive RPC commands:
  - `loadModule({ key, url, specifier })`
  - `getExportNames({ key })` (optional if manifest is authoritative)
  - `invoke({ key, exportName, thisRef?, args })`
  - `construct({ key, exportName, args })` (optional)
  - `releaseRef({ refId })` (optional)

- Import module:
  - `await import(url)` for ESM/canonical file URL

- Expose a stable “module namespace” model:
  - A plain object mapping exportName → callable/value proxy

### Error handling

Return structured errors:

- `name`, `message`, `stack`
- `code` if available (`ERR_ACCESS_DENIED`, etc.)
- Attach permission denial details when present (Node includes `permission` and `resource` in some errors). ([Node.js][1])

---

## RPC protocol spec

### Transport

- Use Node child process IPC channel (`stdio: ['pipe','pipe','pipe','ipc']`).
- Serialization:
  - default structured clone should cover plain objects, arrays, strings, numbers, booleans, null.
  - Prefer enabling “advanced” serialization if you want TypedArrays/ArrayBuffers reliably (implementation detail; document clearly).

### Message envelope

All messages:

```ts
type Msg =
  | { t: "req"; id: number; op: string; p: any }
  | { t: "res"; id: number; ok: true; v: any }
  | { t: "res"; id: number; ok: false; e: SerializedError };
```

Where:

```ts
type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  data?: any; // optional structured metadata
};
```

### Ops

Minimum viable:

- `hello`: version negotiation, capabilities (supportsRefs, supportsNetFlag, nodeVersion)
- `load`: `{ key, url, specifier }` → `{ exportNames? }`
- `call`: `{ key, exportName, args }` → `{ result }`

Optional advanced:

- `get`: `{ refId, prop }`
- `apply`: `{ refId, args }`
- `construct`: `{ refId, args }`
- `keys`: `{ refId }`
- `release`: `{ refId }`

---

## Proxy rules and “RPC-friendly” contract

### Default mode: “value + function only”

Allow:

- JSON-like objects
- arrays
- strings/numbers/booleans/null
- ArrayBuffer/TypedArray (copy)

Disallow (in strict mode):

- streams (Node streams / Web streams)
- sockets
- file handles
- functions-as-data except exported call targets
- classes/instances where prototype identity matters
- objects that rely on getters/setters, Symbols, or complex reflection

Rationale: you want predictable semantics and good error messages rather than half-working mirages.

### Optional: object-reference mode

If enabled per bucket or per package:

- Sandbox can return `{ __ref: 123 }`
- Main creates a `Proxy` object whose traps forward to the sandbox.

Document explicitly what breaks:

- `instanceof` is meaningless
- identity (`===`) does not behave like local objects
- Symbols and property descriptors are lossy
- performance can degrade drastically for chatty object graphs

Recommendation: provide this mode, but keep it **off by default** and require explicit opt-in.

---

## CommonJS support strategy

### Reality

- `require()` is synchronous.
- True cross-process calls are inherently async unless you introduce blocking tricks.

### Recommended stance

1. **Full-featured sandboxing is ESM-first**
   - You get near-zero DX impact and can rely on top-level await.

2. **CJS: supported in a “call-async” style**
   - You can still return an object from `require('pkg')`, but calls return promises:
     - `const md = require('markdown-it'); await md.render(...)`

   - This preserves synchronous require, but introduces async at use.

3. **If you must have synchronous calls**
   - Don’t promise this as “clean”:
     - Worker + `SharedArrayBuffer` + `Atomics.wait` can make sync RPC, but Worker threads don’t give you the process-based Permission Model boundary (and permissions don’t inherit to workers). ([Node.js][1])

   - Treat that as a separate “compat mode” with weaker guarantees.

---

## Popular package compatibility guidance

### Good candidates (typically RPC-friendly)

These are usually “pure compute” or return plain data:

- Parsing/formatting:
  - `markdown-it`, `marked` (string → string)
  - `yaml`, `js-yaml` (string ↔ object)
  - `toml`, `fast-xml-parser`, `xml2js`

- Validation:
  - `ajv` (input → boolean/errors) — may return rich error objects (OK)
  - `zod` (returns objects/errors; generally OK)

- Utilities:
  - `lodash` / `lodash-es` (careful: huge surface area; prefer subpath imports)
  - `date-fns`, `dayjs`, `uuid`, `nanoid`

**DX note:** For very large export surfaces (e.g., `lodash-es`, `rxjs`), generating stubs that enumerate thousands of exports is slow and noisy. Encourage:

- `lodash-es/map`, `date-fns/format`, etc.
- Policy supports subpath mapping (`"date-fns/*": "cpu_only"`).

### Mixed candidates (need explicit rules)

- Template engines:
  - `handlebars` (often OK: template string → string)
  - `nunjucks` may read templates from FS → needs `allowFsRead` to template roots

- HTML sanitizers/highlighters:
  - `sanitize-html`, `highlight.js` (generally OK; check output types)

### Poor candidates (expect friction)

- Anything returning streams/sockets:
  - `got`, `axios`, `node-fetch` (also network-bound)

- Anything using native addons:
  - `sharp`, `sqlite3`, `bcrypt`
  - Requires `--allow-addons` in that bucket, which is a major escalation. ([Node.js][3])

- Anything spawning processes:
  - `execa`, tool wrappers
  - Requires `--allow-child-process` (which is essentially “can spawn anything”). ([Node.js][3])

### Provide a “doctor” command

A CLI tool should:

- Attempt to import each sandboxed package inside a temporary sandbox bucket.
- Detect:
  - uses native addons (fails unless allowed)
  - attempts network/FS writes
  - exports unsupported shapes (streams, functions-as-data patterns)

- Emit an actionable report:
  - “OK in strict mode”
  - “Requires object-ref mode”
  - “Requires addons permission”
  - “Not recommended: spawns processes”

---

## Debuggability and observability

### Required features

- `SANDBOXIFY_DEBUG=1`:
  - logs bucket selection and resolved URLs
  - logs sandbox process PID per request
  - logs denial errors with permission + resource when available

### Stack traces

- Cross-process stack traces are fragmented.
- Minimum: include sandbox-side stack in serialized error.
- Better: attach `sandboxPid`, `bucket`, `moduleKey`, `exportName` metadata.

### Tracing

- Optional “RPC trace mode”:
  - timestamps, queue delay, execution time
  - payload size

- Optional sampling for production.

---

## Security notes you must document (explicitly)

1. **Permission Model is not a hardened sandbox**
   - Node explicitly states it does not protect against malicious code and can be bypassed. ([Node.js][1])

2. **Keep Node patched**
   - There have been Permission Model bypass CVEs; for example, Node security advisories describe network restriction bypass via Unix domain sockets in some cases. ([Node.js][5])

3. **Symlink hazards**
   - Allowed FS read paths can be escaped via symlinks; Node warns about this. ([Node.js][1])
     Your tooling should:
   - warn if allowed directories contain symlinks
   - recommend running sandboxes in containers or dedicated minimal directory trees when strong FS isolation is required (especially with pnpm-style symlinks)

4. **Do not pass sensitive file descriptors**
   - Don’t inherit extra FDs into sandbox processes. ([Node.js][1])

---

## Testing plan

### Unit tests

- Policy matching:
  - exact vs glob vs subpath precedence

- Manifest correctness:
  - stable keys across runs
  - invalidation when package version changes

### Integration tests

- “Denied permission” cases:
  - FS write denied
  - child_process denied
  - net denied (Node v25+)

- Concurrency tests:
  - multiple parallel calls
  - sandbox restart and retry

- ESM semantics:
  - default export
  - named exports
  - namespace import (`import * as x`)

### Compatibility tests (popular packages)

Create a curated suite:

- markdown, yaml, ajv, lodash subpaths, date-fns subpaths, handlebars, nunjucks template load

---

## Deliverables (what a smart AI should implement)

### Package layout (suggested)

- `sandboxify/`
  - `src/policy/` (config parsing, glob mapping, path normalization)
  - `src/loader/` (register hooks, resolve/load implementation)
  - `src/runtime/` (pool manager, RPC client, proxy builder)
  - `src/host/` (sandbox host process entry, module cache, RPC server)
  - `src/manifest/` (build + read + invalidate export manifest)
  - `src/cli/` (`init`, `build-manifest`, `doctor`, `run`)

### CLI commands

- `sandboxify init`
  - creates policy file template + register script

- `sandboxify build-manifest`
  - generates `.sandboxify/exports.manifest.json`

- `sandboxify doctor`
  - runs compatibility checks, prints report

- `sandboxify run -- node ./src/index.mjs`
  - convenience wrapper that sets `--import sandboxify/register.mjs`

### Documentation set

- `README.md`
  - quickstart in <60 seconds
  - “ESM recommended” statement
  - minimal policy example

- `docs/`
  - `policy.md` (schema, examples)
  - `how-it-works.md` (resolve/load → stub → RPC)
  - `compatibility.md` (rules, common packages, patterns)
  - `security.md` (threat model, known limitations, symlinks, CVE/patch guidance)
  - `debugging.md` (logs, env vars, tracing)
  - `cjs.md` (what works, what doesn’t, migration tips)

---

## Two implementation variants (pick one as default)

### Variant A (recommended default): sync hooks + manifest

- Use `module.registerHooks()` for stable in-thread behavior. ([Node.js][4])
- Require `sandboxify build-manifest` in CI/prod.
- Fast startup, predictable, fewer loader caveats.

### Variant B: async hooks + runtime export discovery

- Use `module.register()` and async `load` that can query sandbox for export names at runtime.
- More “magical”, less prebuild friction.
- But Node explicitly warns async hooks have many caveats and encourages `registerHooks()` instead. ([Node.js][4])

---

## Key design decision you should document prominently

1. **Network sandboxing requires Node v25+** if you want `allowNet` buckets to be enforced via Node flags. ([Node.js][3])
2. **ESM is the primary supported mode** for “near-zero callsite changes”.
3. **Treat this as dependency risk reduction, not a perfect sandbox**. ([Node.js][1])

---

## Minimal “spec-level” pseudocode skeletons

### register script (entrypoint preloaded with `--import`)

```js
// register.mjs
import { registerHooks } from "node:module";
import { createSandboxHooks } from "sandboxify/loader";

registerHooks(
  createSandboxHooks({
    policyPath: "./sandboxify.policy.jsonc",
    manifestPath: "./.sandboxify/exports.manifest.json",
  }),
);
```

### resolve hook behavior

```js
function resolve(specifier, context, nextResolve) {
  const bucket = policy.match(specifier);
  if (!bucket) return nextResolve(specifier, context);

  const real = nextResolve(specifier, context);
  const id = hash(
    real.url + "\0" + JSON.stringify(context.importAttributes ?? {}),
  );

  map.set(id, { bucket, realUrl: real.url, specifier });
  return { url: `sandboxify:bucket=${bucket}&id=${id}`, shortCircuit: true };
}
```

### load hook behavior

```js
function load(url, context, nextLoad) {
  if (!url.startsWith("sandboxify:")) return nextLoad(url, context);

  const { bucket, id } = parseSandboxifyUrl(url);
  const rec = map.get(id);
  const exportNames = manifest.get(rec.realUrl) ?? [];

  const source = generateStub({
    bucket,
    specifier: rec.specifier,
    realUrl: rec.realUrl,
    exportNames,
  });

  return { format: "module", source, shortCircuit: true };
}
```

---

If you want to push this from “plan” to “implementation-ready,” the next step is to write the **exact JSON schema**, the **RPC op list**, and the **generated stub code rules** (including edge cases like `default`-only modules, “no exports found”, and very large export lists). The spec above is already structured so an implementer can proceed without further design invention.

[1]: https://nodejs.org/api/permissions.html "https://nodejs.org/api/permissions.html"
[2]: https://nodejs.org/docs/latest-v24.x/api/permissions.html "https://nodejs.org/docs/latest-v24.x/api/permissions.html"
[3]: https://nodejs.org/api/cli.html "https://nodejs.org/api/cli.html"
[4]: https://nodejs.org/api/module.html "https://nodejs.org/api/module.html"
[5]: https://nodejs.org/en/blog/vulnerability/december-2025-security-releases "https://nodejs.org/en/blog/vulnerability/december-2025-security-releases"

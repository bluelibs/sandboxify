# IMPLEMENTATION_PLAN

## Scope
Build an ESM-first `sandboxify` library for Node 25 that sandboxes selected dependencies in separate Node processes using the Permission Model, with sync loader hooks + export manifest, plus docs and tests.

## Assumptions
- Runtime target is Node 25.x (network permission gating uses `--allow-net`).
- Initial implementation prioritizes exact package mapping and simple glob suffix (`*`) matching.
- ESM is the primary supported path; CJS compatibility is out-of-scope for MVP.

## Milestones

### 1) Foundation and package scaffolding
- Create `package.json` (ESM, scripts, exports).
- Add source folders:
  - `src/policy`
  - `src/loader`
  - `src/runtime`
  - `src/host`
  - `src/manifest`
  - `src/cli`
- Add `register.mjs` entry for `node --import`.

**Acceptance**
- Project installs and basic scripts run.

### 2) Policy engine
- Implement policy loading from JSON/JSONC.
- Normalize bucket shape and package mappings.
- Implement deterministic matcher:
  - exact package
  - prefix/suffix wildcard (`@scope/*`, `pkg/*`)
  - precedence: exact > longest wildcard pattern.

**Acceptance**
- Unit tests pass for matching and precedence.

### 3) Manifest system (sync-hook friendly)
- Implement `build-manifest` that resolves configured packages and captures export names.
- Persist to `.sandboxify/exports.manifest.json`.
- Include deterministic keys and metadata (`realUrl`, `package`, timestamp, node version).

**Acceptance**
- Manifest generated and consumed by loader.

### 4) Loader hooks and generated stubs
- Implement `createSandboxHooks({ policyPath, manifestPath })`.
- `resolve` maps sandboxed imports to synthetic `sandboxify:` URLs.
- `load` generates ESM stubs with static default/named exports using manifest.

**Acceptance**
- ESM imports of mapped package transparently route through sandbox runtime.

### 5) Runtime + sandbox host + RPC
- Runtime pool keyed by bucket with process lifecycle and request dispatch.
- Spawn sandbox host with least-privilege flags from bucket permissions.
- Implement RPC operations: `hello`, `load`, `call`.
- Strict serialization contract and structured error propagation.

**Acceptance**
- Calls to exported functions run in child process and return expected values.
- Permission denials propagate with useful messages.

### 6) CLI and DX surface
- Implement CLI commands:
  - `sandboxify build-manifest`
  - `sandboxify doctor` (basic compatibility and config checks)
- Keep API minimal and explicit.

**Acceptance**
- Commands run locally and integrate with sample policy.

### 7) Documentation
- Write `README.md`:
  - quickstart
  - policy example
  - `--import` usage
  - constraints and Node 25 note
- Include concise security caveats.

**Acceptance**
- A new user can run an end-to-end sample in <5 minutes.

### 8) Test suite
- Unit tests:
  - policy matching precedence
  - manifest read/write behavior
- Integration tests:
  - successful sandboxed call path
  - denied `child_process`
  - denied network when `allowNet: false`
  - allowed network when `allowNet: true` (Node 25)

**Acceptance**
- `npm test` passes.

## Parallelization plan
- **Agent A (Core)**: policy + loader + runtime + host.
- **Agent B (Docs)**: README and usage examples aligned to implemented API.
- **Agent C (Tests)**: unit + integration once core API is stable.

## Done criteria
- (a) Library works end-to-end with `node --import ./register.mjs`.
- (b) `README.md` documents setup, usage, and caveats.
- (c) Test suite validates policy, manifest, and permission enforcement behavior.

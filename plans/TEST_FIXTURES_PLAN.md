# TEST_FIXTURES_PLAN

## Goal
Move integration coverage to isolated fixture projects with deterministic local `node_modules` emulation (offline), so permission behavior and loader hooks are validated realistically.

## Target structure
- `test/fixtures/apps/<scenario>/` app entrypoints + policy templates
- `test/fixtures/vendor/<pkg>/<version>/` vendored package sources
- `test/fixtures/scenarios/*.json` scenario declarations
- `test/helpers/fixture-runner.js` temp-dir lifecycle + execution helpers
- `test/helpers/vendor-install.js` materialize `node_modules` from vendor store

## Rules
- Never run fixtures in-place; always copy to temp dir.
- Build manifest after fixture materialization.
- Prefer copies/hardlinks over symlinks for permission-path determinism.
- Keep each test fully isolated (`cwd`, env vars, ports, files).

## Unit vs Integration split
### Unit tests (fast, deterministic)
- policy normalization and matching precedence
- manifest shape and fallback behavior
- loader resolve/load branch logic and stub generation
- rpc error serialization/deserialization

### Integration tests (real Node processes)
- sandboxed function call path
- denied child_process
- denied/allowed network (Node 25)
- import-side-effect denial behavior (net at module init)
- process lifecycle and teardown behavior

## Rollout steps
1. Create fixture helper APIs and migrate one integration test.
2. Migrate all integration tests to fixture scenarios.
3. Add symlink/canonical-path regression scenarios.
4. Enable parallel-friendly execution where safe.

## Success criteria
- Integration tests do not require network installs.
- No flaky cross-test interference from shared state.
- Reproducible results across local and CI environments.

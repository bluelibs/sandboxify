# COMPATIBILITY_ROADMAP_PLAN

## Goal
Define practical support boundaries for CJS/MJS, TypeScript, conditional network behavior, and importer-folder policy expansion.

## Current stance
- ESM-first sandboxing is primary and stable path.
- CJS transparent parity is not guaranteed in MVP.
- TypeScript compiles against original package types; runtime behavior may differ for sync exports due to async RPC.

## CJS/MJS roadmap
1. **Now:** Document ESM-first guarantee and CJS best-effort behavior.
2. **Next:** Add explicit CJS bridge API (`await sandboxify.require('pkg')`).
3. **Later:** Optional experimental `require()` interception behind feature flag.

## TypeScript roadmap
1. Add docs for runtime async caveat on sandboxed function exports.
2. Add TS integration fixtures (`NodeNext`, build-step run).
3. Add source-map guidance for parent and child processes.
4. Evaluate optional generated `.d.ts` overlays only if on-disk stubs are introduced.

## Conditional network behavior
- `allowNet=false`: non-network code paths should still work; calls that touch network fail at call-time.
- `allowNet=true`: network paths succeed.
- Add explicit tests for both lazy network and import-time side-effect network.

## Importer-folder/domain policies
### MVP extension
- Introduce `importerRules` in policy, matching `context.parentURL` + target specifier.
- Precedence: exact importer/specifier > wildcard importer/specifier > legacy package rules.

### Caveats
- Restriction only applies to code routed through sandbox.
- Unsandboxed main-process modules remain unrestricted by this library.

## Deliverables
- README updates for compatibility matrix
- policy schema extension proposal for `importerRules`
- integration tests for folder-based bucket selection

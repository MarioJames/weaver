# Tests

Tests live in one subdirectory per layer under test, mirroring `src/`:

- `main/` — backend modules under `src/main`
- `cli/` — the CLI under `src/cli`
- `renderer/` — the frontend under `src/renderer`
- `shared/` — cross-boundary contracts and rules under `src/shared`
- `integration/` — cross-layer end-to-end tests (HTTP runtime, standalone bundle, skills install) and the dependency-direction guard (`architecture-boundaries.test.ts`)

`helpers/` holds shared test utilities and `fixtures/` holds data files; neither contains tests. The `test` script in `package.json` discovers tests recursively via the glob `'tests/**/*.test.ts'`, so any file matching `tests/**/*.test.ts` in a subdirectory is picked up automatically — helper and fixture files must therefore never end in `.test.ts`. New tests go in the subdirectory matching the layer they exercise; cross-layer end-to-end cases go in `integration/`.

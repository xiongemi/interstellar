# TIA — Test Impact Analysis for this monorepo

Runs **only the tests a change can actually affect**, computed from a single
workspace-wide dependency graph instead of per-runner `--changedSince`.

## Why not `jest --changedSince`?

`--changedSince` (and the equivalent on vitest / rstest / playwright) understands
**one project's** module graph. It resolves `@interstellar/*` path aliases through
that runner's own config and never crosses the project boundary — so a change in
`libs/shared/icons` won't select the tests in `libs/crew/*` that depend on it. In a
monorepo it **under-selects**, which silently ships regressions.

`tia.mjs` builds one graph across every `apps/**` and `libs/**` source file
(resolving TS path aliases, relative imports, and `.css` side-effect imports), then
walks it **in reverse** from the git-changed files to the test files they reach.

## Usage

```bash
# Print the impacted projects / tests vs origin/main (no execution)
yarn tia

# Diff against a different ref
yarn tia --base origin/release

# Actually run the affected unit tests / e2e
yarn tia:test        # jest --runTestsByPath <affected specs>
yarn tia:e2e         # playwright for affected apps only

# Machine-readable output (also always written to tools/tia/tia-affected.json)
yarn tia --json

# Diagnose the graph around one file — spot barrel over-selection
yarn tia --explain libs/shared/icons/src/lib/icon0/icon0.tsx
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base <ref>` | `origin/main` | Ref to diff against (uses `merge-base`). |
| `--runner <r>` | `jest` | `jest` \| `vitest` \| `rstest` \| `playwright`. |
| `--run` | off | Execute the tests (otherwise just print + write JSON). |
| `--json` | off | Emit machine-readable JSON. |
| `--explain <file>` | – | Show direct importers + transitive blast radius of one file. |
| `--verbose` | off | Graph/timing diagnostics to stderr. |

## How impact is computed

1. **Alias map** — parse `compilerOptions.paths` from `tsconfig.base.json`.
2. **Graph** — scan every source file's `import` / `export … from` / `require` /
   dynamic `import()`, resolve each specifier to an absolute file, and record the
   reverse edge `importee → importer`.
3. **Changed set** — `git diff <merge-base>...HEAD` plus uncommitted/untracked
   working-tree changes.
4. **Reverse BFS** — from every changed file, collect all transitive importers.
   The `*.spec.*` / `*.test.*` files in that set are the impacted unit tests; any
   `apps/<app>` reached maps to the `<app>-e2e` Playwright project.
5. **Global fallback** — a change to `nx.json`, `tsconfig.base.json`,
   `jest.preset.js`, `package.json`, `yarn.lock`, … can't be bounded, so TIA runs
   **everything** and says so.

## Known limitation: barrel files

Barrels (`export * from …`) collapse the graph. Every leaf here does
`import * as icons from '@interstellar/shared/icons'`, so a one-line change to any
icon flows through the barrel to **all 25k specs**:

```
$ yarn tia --explain libs/shared/icons/src/lib/icon0/icon0.tsx
  direct importers .... 2
  transitive affected . 50403 files, 25101 tests   ← the whole suite
```

Deep imports (`@interstellar/shared/icons/icon0`) instead of the barrel keep the
blast radius proportional to the change. See
[`docs/blog/test-impact-analysis-for-monorepos.md`](../../docs/blog/test-impact-analysis-for-monorepos.md)
for the full rationale and trade-offs.

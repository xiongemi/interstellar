# Test Impact Analysis for Monorepos: why `--changedSince` isn't enough

> **TL;DR** Every major test runner ships a "only run tests affected by my changes" flag — `jest --changedSince`, `vitest --changed`, `rstest --changed`, `playwright --only-changed`. In a **monorepo** they all share the same blind spot: they reason about *one project's* module graph and can't follow an import across a project boundary. So they **under-select** and silently skip tests that should have run. The fix is a small custom script that builds **one workspace-wide dependency graph** and walks it in reverse from the changed files. This post explains the approach we shipped in `tools/tia/tia.mjs`, the one thing that quietly destroys it (**barrel files**), and the trade-offs you sign up for (**you lose remote cache**, and you accept **false positives**).

---

## What is Test Impact Analysis?

Test Impact Analysis (TIA) is the technique of running only the tests that a change can actually affect, instead of the whole suite. Conceptually:

1. Build a map of *what depends on what* (a code dependency / call graph).
2. Find what changed (usually via git).
3. Select the tests that transitively depend on the changed code.
4. Run only those.

Done right, a one-line fix runs 2 tests in under a second instead of the entire suite. Done wrong, it skips the one test that would have caught your bug.

---

## This monorepo, by the numbers

To make the trade-offs concrete, here's the workspace this post is measured against — a synthetic-but-realistic Nx monorepo modeled on a large product codebase:

- **115 Nx projects** — 5 Next.js apps (`crew`, `flight-simulator`, `navigation`, `ticket-booking`, `warp-drive-manager`), their 5 Playwright e2e projects, 5 shared UI libraries (`icons`, `components`, `buttons`, `alerts`, `dialogs`), and 100 feature libraries.
- **53,072 TypeScript source files** — the dependency graph across them is 79,432 nodes and 227,920 edges.
- **26,360 Jest spec files** (≈ 26,365 `it`/`test` cases — roughly one render test per component), plus **5 Playwright e2e** specs.

And the number that motivates all of this — the full Jest run:

- **Full suite: 26,360 suites / 26,360 tests, all green, in ~204 s (≈ 3.4 minutes)** — Jest's own reported wall time on a dev machine at 50% workers with the SWC transform. On a single `ubuntu-latest` CI runner (fewer cores, cold cache) it is materially slower, and that time is paid on *every* PR push.
- **With TIA: a one-line leaf change runs 2 tests in ~0.7 s** — the graph build that decides this takes ~7 s once.

So the whole point is turning a ~3.4-minute (and on CI, longer) tax on every change into a sub-second one — *when the dependency graph is precise enough to allow it*. The rest of this post is about when it is, and when barrels quietly take that precision away.

---

## The promise: `--changedSince`

Every runner has a version of this:

- **Jest** — `jest --changedSince=origin/main` (also `--onlyChanged`, `--findRelatedTests <files>`)
- **Vitest** — `vitest --changed origin/main`
- **Rstest** — `rstest --changed`
- **Playwright** — `playwright test --only-changed=origin/main`

They work by asking git for changed files, then using the runner's own **Haste map / module graph** to find test files whose dependency graph includes a changed file.

For a **single-package** repo this is great. For a **monorepo**, it breaks — and the failure is silent.

---

## Why `--changedSince` breaks in a monorepo

In this workspace a leaf component imports shared code through a TypeScript path alias, not a relative path:

```ts
// libs/navigation/important-feature-2/src/lib/important-component-32/important-component-32.tsx
import * as icons from '@interstellar/shared/icons';
```

That alias is declared in `tsconfig.base.json`:

```jsonc
"@interstellar/shared/icons": ["./libs/shared/icons/src/index.ts"]
```

Now change a file in `libs/shared/icons` and run Jest's changed-file mode. Two things go wrong:

1. **Per-project graphs don't compose.** Nx runs Jest with a *multi-project* root config — 115 separate project configs, each with its own `roots`, `moduleNameMapper`, and transform. `--changedSince` computes "related tests" **within each project's own file set**. The changed file lives in the `shared-icons` project; the tests that depend on it live in `crew-*`, `navigation-*`, etc. Nothing connects the changed file in one project to the dependent tests in another. Result: Jest runs `shared-icons`' own tests and **skips every downstream consumer** — a false negative.

2. **Alias resolution is inconsistent.** Whether a runner even *sees* the edge depends on it resolving `@interstellar/shared/icons` → the real file the same way the TypeScript compiler does. Jest does it via `moduleNameMapper`, Vitest via its resolver, Playwright not at all for unit-style graphs. The graph the runner walks is not the graph your code actually has.

The picture for (1) — the change and the tests that *should* react to it, versus what each project's `--changedSince` can actually see:

```text
git says 1 file changed:  libs/shared/icons/src/lib/icon0/icon0.tsx


(A) REALITY — a single graph; the import edge crosses project boundaries

    shared-icons · icon0.tsx   ● CHANGED
        │
        │  re-exported by the barrel, imported as
        │  '@interstellar/shared/icons'  from every app and lib
        ▼
        ├──▶ shared-icons      · icon0.spec.tsx        ✅ SHOULD RUN
        ├──▶ crew-*            · component.spec.tsx     ✅ SHOULD RUN
        ├──▶ navigation-*      · component.spec.tsx     ✅ SHOULD RUN
        ├──▶ ticket-booking-*  · component.spec.tsx     ✅ SHOULD RUN
        └──▶ warp-drive-*      · component.spec.tsx     ✅ SHOULD RUN


(B) WHAT  jest --changedSince  SEES — 115 project graphs, none connected

    project shared-icons
        │  git-changed ∩ my file-set = { icon0.tsx }
        └──▶ icon0.spec.tsx                            ✅ RUN

    project navigation-*   (and crew-*, ticket-booking-*, warp-drive-*)
        │  git-changed ∩ my file-set = { }     ← icon0 is not in my roots
        │  the '@interstellar/shared/icons' edge is invisible across the border
        └──▶ (nothing selected)                        ❌ SKIPPED   ← false negative
```

Each project's `--changedSince` intersects the git-changed set with *its own* files. `shared-icons` finds `icon0.tsx` and runs one test; every consumer project finds an empty intersection and runs nothing — even though their components import the changed file. The edge exists in your code; it does not exist in any single project's graph.

Under-selection is the dangerous failure mode: **your CI goes green because it didn't run the test that would have gone red.** This is why the repo guidance says plainly: *"the jest `--changedSince` flag does not work for monorepo."* It's not a bug in Jest — it's a category error. `--changedSince` was never designed to reason across project boundaries.

---

## The fix: one workspace-wide graph

The missing piece is a dependency graph that spans the **entire** workspace and understands the **same** module resolution your build uses. That's all `tools/tia/tia.mjs` is:

1. **Read the alias map** from `tsconfig.base.json` (`compilerOptions.paths`).
2. **Scan every source file** in `apps/**` and `libs/**` for `import` / `export … from` / `require()` / dynamic `import()`, and resolve each specifier to an absolute file — following relative paths, path aliases, and `.css` side-effect imports.
3. **Record the reverse edge** `importee → importer`.
4. **Find changed files** via `git diff <merge-base>...HEAD` plus the working tree.
5. **Reverse-BFS** from the changed files to every transitive importer. The `*.spec.*` / `*.test.*` files in that set are the impacted unit tests; any `apps/<app>` file reached maps to that app's `<app>-e2e` Playwright project.

On this repo the graph is **53,072 source files → 79,432 nodes / 227,920 edges**, and it builds in about **7 seconds** with zero dependencies beyond Node. That's fast enough to run at the top of every CI job.

```bash
$ yarn tia                       # print impacted projects/tests vs origin/main
$ yarn tia:test                  # run only the affected jest specs
$ yarn tia:e2e                   # run only the affected playwright projects
$ yarn tia --explain <file>      # debug the blast radius of one file
```

Because step 5 produces a plain **list of affected test files** (`tools/tia/tia-affected.json`), it's runner-agnostic — feed the same list to Jest (`--runTestsByPath`), Vitest (`vitest related`), Rstest, or Playwright. The graph is the product; the runner is a detail.

### It works

Change one leaf component:

```
$ yarn tia
changed files ........ 1
affected unit tests .. 2
unit test projects ... 1:  navigation-important-feature-2
e2e projects ......... 1:  navigation-e2e
```

Two specs instead of 26,360. The `navigation-e2e` project is correctly pulled in because the `navigation` app renders that feature.

---

## The thing that ruins everything: barrel files

Here is the same tool pointed at a single icon:

```
$ yarn tia --explain libs/shared/icons/src/lib/icon0/icon0.tsx
  direct importers .... 2
  transitive affected . 50403 files, 25101 tests   ← basically the whole suite
```

One trivial icon change selects **25,101 of 26,360 tests**. TIA gives you *nothing*. Why?

### How a barrel collapses the graph

`libs/shared/icons/src/index.ts` is a **barrel**:

```ts
export * from './lib/icon0/icon0';
export * from './lib/icon1/icon1';
// … 250 more
```

And every consumer imports the **barrel**, not the icon:

```ts
import * as icons from '@interstellar/shared/icons';   // → src/index.ts
```

So the real dependency edges are:

```
icon0.tsx ─▶ index.ts (barrel) ─▶ 25,000 consumer components ─▶ their specs
```

From the graph's point of view, **touching any one of the 250 icons is indistinguishable from touching the barrel**, and touching the barrel means touching every one of its 25,000 consumers. The barrel is a hub that fuses 250 unrelated files into a single node. Precise change detection upstream is wasted the moment it flows through a barrel downstream.

This is *correct* — those consumers really do `import` the barrel, and if the barrel's public surface changed they really could be affected. It's just useless. And note this is **not a false positive in the graph** — it's the barrel destroying the information TIA needs. `git` knew only `icon0` changed; the barrel threw that knowledge away.

### The remedy: no barrel files, deep imports

To get fine-grained TIA you have to let the graph *see* which specific file changed. That means dropping barrels on the hot paths and importing the leaf directly:

```ts
// ❌ barrel — every consumer depends on all 250 icons
import { Icon0 } from '@interstellar/shared/icons';

// ✅ deep import — this consumer depends on exactly one icon
import { Icon0 } from '@interstellar/shared/icons/icon0';
```

With deep imports, changing `icon0` reaches only the handful of files that import `icon0` — and its blast radius shrinks from 25,101 tests to a few. Concretely you'd:

- **Stop re-exporting through `index.ts`** for the shared libraries that everything depends on (icons, components, buttons, alerts, dialogs here).
- **Expose per-entry-point subpaths** (via `tsconfig` path aliases or `package.json` `exports`) so consumers can address a single file.
- **Enforce it with lint** — `no-restricted-imports` / `eslint-plugin-import`, or Nx's `enforce-module-boundaries`, to ban importing the barrel.

The cost is real: barrels are ergonomic, and killing them means noisier imports and a migration across thousands of call sites. That is the central trade of monorepo TIA — **you trade import ergonomics for test-selection precision.** If you keep the barrels, keep the whole test suite too.

> Rule of thumb: `yarn tia --explain <a-leaf-file>`. If a one-line leaf shows a transitive blast radius of thousands of tests, a barrel is standing between you and useful TIA.

---

## The trade-offs (read before adopting)

TIA is not free. Three things you're signing up for:

### 1. You lose the remote cache

Nx's killer feature is **caching keyed on inputs**: if a project's inputs hash to something already computed (locally or in remote/Nx Cloud cache), the task is *restored*, not re-run — and every teammate and CI job shares those hits. `nx affected` is designed to cooperate with this: it decides *which projects* might have changed, and the cache decides *which of those can be skipped*.

A file-level TIA script that hand-picks individual **test files** and invokes `jest --runTestsByPath …` steps **outside** that model:

- The run isn't a cacheable Nx *task* with a stable input hash, so it produces **no cache entry** and can **restore none**. Every TIA run is a cold run.
- You lose cross-run and cross-machine reuse. Nx could tell you "these 40 projects are affected, but 38 are cache hits, run 2." TIA says "run these 900 test files" every time, from scratch.
- On a warm cache, `nx affected -t test` can beat file-level TIA precisely because it *skips* work rather than *re-selecting* it.

So the honest framing is: **file-level TIA trades cache reuse for selection granularity.** It shines on cold caches (fresh CI runners, cache misses, the barrel problem above where `affected` would pick 100 projects). If your remote cache hit-rate is already high, plain `nx affected` may be faster and you should measure before switching.

### 2. False positives (over-selection)

Even with a perfect graph you will run tests that couldn't actually break:

- **Barrels** (above) — the dominant source here.
- **Coarse edges** — `import * as x` pulls the whole module; the graph can't see that you only used one export. Type-only imports (`import type`) are erased at runtime but still create graph edges.
- **Shared low-level utilities** — a change to a truly ubiquitous helper legitimately fans out to most of the repo.

False positives waste CI minutes but are **safe**. They're the acceptable failure mode.

### 3. False negatives (the dangerous kind) and the global fallback

A static import graph cannot see every real dependency:

- **Dynamic / computed imports** — `import(`./${name}`)`, plugin registries, DI containers, string-keyed lookups.
- **Non-import coupling** — snapshot fixtures, environment variables, generated code, a shared test database, network contracts.
- **Config and tooling** — a change to `jest.preset.js` or `tsconfig.base.json` affects everything but is imported by nothing.

For that last category, `tia.mjs` deliberately **bails out**: a change to `nx.json`, `tsconfig.base.json`, `jest.preset.js`, `package.json`, `yarn.lock`, or the lint config sets `runEverything` and runs the full suite. That's the safety valve — TIA should fail *open* (run more) when it's unsure, never fail *closed*.

```
$ yarn tia
⚠  Global file changed → running EVERYTHING: package.json
```

You cannot fully eliminate false negatives with static analysis. Mitigations: keep a periodic **full** run (nightly / pre-merge to `main`) as a backstop, and expand the global-file list whenever you find an untracked coupling.

---

## Adopting it in CI

The conservative rollout keeps a full run on `main` and uses TIA only to *speed up PRs*:

```yaml
# .github/workflows/pr.yml (sketch)
- run: yarn install --frozen-lockfile
- name: Test impact analysis
  run: yarn tia --base origin/${{ github.base_ref }} --json
- name: Run affected unit tests
  run: yarn tia:test --base origin/${{ github.base_ref }}
- name: Run affected e2e
  run: yarn tia:e2e --base origin/${{ github.base_ref }}
```

- **PRs** run TIA (fast, may over-select through barrels).
- **`main` / nightly** run the full suite (`yarn jest`, `yarn e2e:all`) — the backstop that catches anything TIA's static graph missed.

---

## Verdict

How the three approaches compare, dimension by dimension:

- **Crosses project boundaries** — `nx affected`: yes. `--changedSince`: no (under-selects). Custom TIA: yes.
- **Granularity** — `nx affected`: project. `--changedSince`: file (single project). Custom TIA: file (whole workspace).
- **Uses remote cache** — `nx affected`: yes. `--changedSince`: n/a. Custom TIA: no.
- **Hurt by barrels** — `nx affected`: yes (whole projects). `--changedSince`: yes. Custom TIA: yes.
- **Safe on config changes** — `nx affected`: yes. `--changedSince`: risky. Custom TIA: yes (runs everything).

Reach for a custom workspace-wide TIA script when: your cache hit-rate is low, your runner's `--changedSince` is under-selecting across projects, and you're willing to **kill barrel files** to make the graph precise. Keep `nx affected` + remote cache when your caches are warm and barrels are staying.

The one non-negotiable: **TIA is only as good as your dependency graph, and barrel files are the fastest way to throw that graph away.**

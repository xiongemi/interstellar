#!/usr/bin/env node
// @ts-check
/**
 * Test Impact Analysis (TIA) for an Nx monorepo.
 *
 * Why this exists
 * ---------------
 * `jest --changedSince` (and the equivalent flags on vitest / rstest / playwright)
 * only understands ONE project's module graph. In a monorepo, a change in
 * `libs/shared/icons` has to trigger tests in every project that imports it, but
 * each runner resolves `@interstellar/*` path aliases through its own config and
 * never crosses the project boundary. So `--changedSince` silently *under-selects*
 * (misses cross-project impact) — which is worse than useless for CI.
 *
 * This script builds ONE workspace-wide, file-level dependency graph — resolving
 * TypeScript path aliases, relative imports, and CSS side-effect imports — then
 * walks it in reverse from the git-changed files to find exactly the test files
 * (and the projects that own them) that a change can affect.
 *
 * Usage
 * -----
 *   node tools/tia/tia.mjs [--base <ref>] [--runner jest|vitest|rstest|playwright]
 *                          [--run] [--json] [--verbose]
 *
 *   --base <ref>   Git ref to diff against (default: origin/main). Uses merge-base.
 *   --runner <r>   Which runner to print/execute commands for (default: jest).
 *   --run          Actually execute the selected tests (default: just print).
 *   --json         Emit machine-readable JSON only.
 *   --verbose      Print graph/timing diagnostics to stderr.
 *
 * No dependencies beyond Node built-ins.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOURCE_DIRS = ['apps', 'libs'];
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const ASSET_EXTS = ['.css', '.scss', '.sass', '.less']; // side-effect imports we track as leaves
const RESOLVE_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.nx', 'out-tsc']);
const TEST_RE = /\.(spec|test)\.[jt]sx?$/;

// A change to any of these invalidates the whole workspace — no graph can bound
// their blast radius, so TIA must fall back to "run everything".
const GLOBAL_FILES = new Set([
  'nx.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'jest.config.js',
  'jest.preset.js',
  'babel.config.json',
  'package.json',
  'yarn.lock',
  'eslint.config.mjs',
]);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { base: 'origin/main', runner: 'jest', run: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--runner') args.runner = argv[++i];
    else if (a === '--run') args.run = true;
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--explain') args.explain = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 34).join('\n').replace(/^ \*?/gm, ''));
  process.exit(0);
}

const log = (...m) => args.verbose && console.error('[tia]', ...m);
const t0 = Date.now();

// ---------------------------------------------------------------------------
// JSONC (tsconfig) reader
// ---------------------------------------------------------------------------

/** Strip // and /* *\/ comments and trailing commas, respecting string literals. */
function stripJsonc(src) {
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  // remove trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJsonc(file) {
  return JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// Build the alias map from tsconfig.base.json paths
// ---------------------------------------------------------------------------

/** @type {{exact: Map<string,string>, wildcard: Array<{prefix:string, target:string}>}} */
const aliases = { exact: new Map(), wildcard: [] };

function loadAliases() {
  const tsconfig = readJsonc(path.join(WORKSPACE_ROOT, 'tsconfig.base.json'));
  const paths = tsconfig.compilerOptions?.paths ?? {};
  for (const [key, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? targets[0] : targets;
    if (!target) continue;
    const absTarget = path.resolve(WORKSPACE_ROOT, target);
    if (key.endsWith('/*')) {
      aliases.wildcard.push({ prefix: key.slice(0, -1), target: absTarget.replace(/\*$/, '') });
    } else {
      aliases.exact.set(key, absTarget);
    }
  }
  log(`loaded ${aliases.exact.size} exact + ${aliases.wildcard.length} wildcard aliases`);
}

// ---------------------------------------------------------------------------
// Enumerate all source + asset files
// ---------------------------------------------------------------------------

/** @type {Set<string>} absolute paths of every file we know about */
const fileSet = new Set();
/** @type {string[]} scannable source files (we read these for imports) */
const sourceFiles = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (SOURCE_EXTS.includes(ext)) { fileSet.add(full); sourceFiles.push(full); }
      else if (ASSET_EXTS.includes(ext)) { fileSet.add(full); }
    }
  }
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

/** Resolve a candidate path (without extension) to a real file in fileSet. */
function resolveFile(candidate) {
  if (fileSet.has(candidate)) return candidate;
  // asset with explicit extension already tried above; try source extensions
  for (const ext of RESOLVE_EXTS) {
    if (fileSet.has(candidate + ext)) return candidate + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = path.join(candidate, 'index' + ext);
    if (fileSet.has(idx)) return idx;
  }
  return null;
}

/** Resolve an import specifier from `fromFile` to an absolute file, or null if external. */
function resolveImport(spec, fromFile) {
  // strip query/hash
  spec = spec.replace(/[?#].*$/, '');
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = spec.startsWith('/') ? path.join(WORKSPACE_ROOT, spec) : path.resolve(path.dirname(fromFile), spec);
    // asset with explicit extension
    if (ASSET_EXTS.includes(path.extname(base))) return fileSet.has(base) ? base : null;
    return resolveFile(base);
  }
  // exact alias
  const exact = aliases.exact.get(spec);
  if (exact) return fileSet.has(exact) ? exact : resolveFile(exact.replace(/\.[jt]sx?$/, ''));
  // wildcard alias
  for (const { prefix, target } of aliases.wildcard) {
    if (spec.startsWith(prefix)) {
      const rest = spec.slice(prefix.length);
      return resolveFile(path.join(target, rest));
    }
  }
  return null; // bare package → external, ignore
}

// ---------------------------------------------------------------------------
// Import extraction + reverse graph
// ---------------------------------------------------------------------------

// Matches: import ... from 'x' | export ... from 'x' | import 'x' | require('x') | import('x')
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

/** reverse graph: importee (absolute) -> Set<importer (absolute)> */
const reverseGraph = new Map();

function addEdge(importee, importer) {
  let set = reverseGraph.get(importee);
  if (!set) reverseGraph.set(importee, (set = new Set()));
  set.add(importer);
}

function buildGraph() {
  let edges = 0;
  for (const file of sourceFiles) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Note: barrels use only `export … from`, so we must check for `export` too.
    if (!src.includes('import') && !src.includes('export') && !src.includes('require')) continue;
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      const target = resolveImport(spec, file);
      if (target && target !== file) { addEdge(target, file); edges++; }
    }
  }
  log(`graph: ${sourceFiles.length} source files, ${fileSet.size} total nodes, ${edges} edges`);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** @type {Array<{name:string, root:string, absRoot:string, type:'app'|'e2e'|'lib'}>} */
let projects = [];

function loadProjects() {
  const found = [];
  for (const dir of SOURCE_DIRS) {
    collectProjectJson(path.join(WORKSPACE_ROOT, dir), found);
  }
  projects = found.map((file) => {
    const cfg = readJsonc(file);
    const root = path.dirname(file);
    const rel = path.relative(WORKSPACE_ROOT, root);
    const isE2e = /-e2e$/.test(cfg.name ?? rel) || fs.existsSync(path.join(root, 'playwright.config.ts'));
    const isApp = rel.startsWith('apps/') && !isE2e;
    return { name: cfg.name ?? rel, root: rel, absRoot: root, type: isE2e ? 'e2e' : isApp ? 'app' : 'lib' };
  });
  // longest root first so nested projects win the prefix match
  projects.sort((a, b) => b.absRoot.length - a.absRoot.length);
  log(`loaded ${projects.length} projects`);
}

function collectProjectJson(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'project.json') out.push(path.join(dir, e.name));
    else if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
      collectProjectJson(path.join(dir, e.name), out);
    }
  }
}

/** Find the project that owns an absolute file path. */
function projectOf(absFile) {
  for (const p of projects) {
    if (absFile === p.absRoot || absFile.startsWith(p.absRoot + path.sep)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git — changed files
// ---------------------------------------------------------------------------

function git(...gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: WORKSPACE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedFiles(base) {
  let mergeBase = git('merge-base', base, 'HEAD').trim();
  if (!mergeBase) mergeBase = base; // base may be a raw SHA with no common ancestor lookup
  const rels = new Set();
  const add = (line) => { const f = line.trim(); if (f) rels.add(f); };
  git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').forEach(add);
  // uncommitted + staged + untracked working-tree changes
  git('status', '--porcelain').split('\n').forEach((line) => {
    if (!line.trim()) return;
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // renames
    add(p);
  });
  return { mergeBase, files: [...rels] };
}

// ---------------------------------------------------------------------------
// Impact analysis (reverse BFS)
// ---------------------------------------------------------------------------

function computeAffected(changedAbs) {
  const affected = new Set();
  const queue = [];
  for (const f of changedAbs) {
    if (!affected.has(f)) { affected.add(f); queue.push(f); }
  }
  while (queue.length) {
    const cur = queue.pop();
    const importers = reverseGraph.get(cur);
    if (!importers) continue;
    for (const imp of importers) {
      if (!affected.has(imp)) { affected.add(imp); queue.push(imp); }
    }
  }
  return affected;
}

// ---------------------------------------------------------------------------
// Runner commands
// ---------------------------------------------------------------------------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function runJest(relTestFiles) {
  if (!relTestFiles.length) { console.log('No affected jest tests — skipping.'); return 0; }
  let failed = 0;
  for (const group of chunk(relTestFiles, 400)) {
    try {
      execFileSync('yarn', ['jest', '--runTestsByPath', ...group, '--cache', '--cacheDirectory=.jest/cache', '--watchman=false'], {
        cwd: WORKSPACE_ROOT,
        stdio: 'inherit',
      });
    } catch {
      failed = 1;
    }
  }
  return failed;
}

function runPlaywright(e2eProjects) {
  if (!e2eProjects.length) { console.log('No affected e2e projects — skipping.'); return 0; }
  let failed = 0;
  for (const p of e2eProjects) {
    const config = path.join(p.root, 'playwright.config.ts');
    try {
      execFileSync('yarn', ['playwright', 'test', '-c', config], { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
    } catch {
      failed = 1;
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  loadAliases();
  SOURCE_DIRS.forEach((d) => walk(path.join(WORKSPACE_ROOT, d)));
  buildGraph();
  loadProjects();

  // `--explain <file>` — diagnose the graph around one file (great for spotting
  // barrel over-selection: a leaf with the whole world as its importers).
  if (args.explain) {
    const target = path.resolve(WORKSPACE_ROOT, args.explain);
    const importers = reverseGraph.get(target);
    const affected = computeAffected([target].filter((f) => fileSet.has(f)));
    const affectedTests = [...affected].filter((f) => TEST_RE.test(f)).length;
    console.log(`explain: ${path.relative(WORKSPACE_ROOT, target)}`);
    console.log(`  in graph ............ ${fileSet.has(target)}`);
    console.log(`  direct importers .... ${importers ? importers.size : 0}`);
    console.log(`  transitive affected . ${affected.size} files, ${affectedTests} tests`);
    if (importers) [...importers].slice(0, 8).forEach((f) => console.log(`    <- ${path.relative(WORKSPACE_ROOT, f)}`));
    return;
  }

  const { mergeBase, files: changedRel } = changedFiles(args.base);

  // global invalidation?
  const globalHit = changedRel.filter((f) => GLOBAL_FILES.has(f));
  const runEverything = globalHit.length > 0;

  const changedAbs = changedRel
    .map((f) => path.join(WORKSPACE_ROOT, f))
    .filter((f) => fileSet.has(f)); // only files that participate in the graph

  const affected = runEverything ? null : computeAffected(changedAbs);

  // affected test files
  let affectedTestAbs;
  if (runEverything) {
    affectedTestAbs = sourceFiles.filter((f) => TEST_RE.test(f));
  } else {
    affectedTestAbs = [...affected].filter((f) => TEST_RE.test(f));
  }

  // partition tests into jest (unit) vs e2e (playwright)
  const jestTestAbs = [];
  const affectedProjectNames = new Set();
  const affectedAppNames = new Set();
  for (const f of affectedTestAbs) {
    const p = projectOf(f);
    if (!p) continue;
    if (p.type === 'e2e') continue; // playwright handled via app dependency below
    jestTestAbs.push(f);
    affectedProjectNames.add(p.name);
  }

  // affected apps (for e2e): any app that owns an affected file
  const affectedForApps = runEverything ? new Set(sourceFiles) : affected;
  for (const f of affectedForApps) {
    const p = projectOf(f);
    if (p && p.type === 'app') affectedAppNames.add(p.name);
  }
  const e2eProjects = projects.filter(
    (p) => p.type === 'e2e' && (runEverything || affectedAppNames.has(p.name.replace(/-e2e$/, ''))),
  );

  const jestTestRel = jestTestAbs.map((f) => path.relative(WORKSPACE_ROOT, f)).sort();
  const testProjects = [...affectedProjectNames].sort();
  const e2eProjectNames = e2eProjects.map((p) => p.name).sort();

  const result = {
    base: args.base,
    mergeBase,
    runEverything,
    globalTriggers: globalHit,
    changedFiles: changedRel.length,
    changedInGraph: changedAbs.length,
    affectedFiles: runEverything ? fileSet.size : affected.size,
    affectedTestFiles: jestTestRel.length,
    affectedTestProjects: testProjects,
    affectedE2eProjects: e2eProjectNames,
    tests: jestTestRel,
  };

  // persist for other tooling / other runners
  fs.writeFileSync(path.join(__dirname, 'tia-affected.json'), JSON.stringify(result, null, 2));

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  log(`done in ${Date.now() - t0}ms`);

  if (args.run) {
    let code = 0;
    if (args.runner === 'jest') code = runJest(jestTestRel);
    else if (args.runner === 'playwright') code = runPlaywright(e2eProjects);
    else {
      console.error(`--run for runner "${args.runner}" is not wired to execute in this repo; use the printed command.`);
    }
    process.exit(code);
  }
}

function printSummary(r) {
  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Test Impact Analysis  (base: ${r.base} → ${r.mergeBase.slice(0, 12)})`);
  console.log(line);
  if (r.runEverything) {
    console.log(`⚠  Global file changed → running EVERYTHING: ${r.globalTriggers.join(', ')}`);
  }
  console.log(`changed files ........ ${r.changedFiles}  (${r.changedInGraph} in graph)`);
  console.log(`affected files ....... ${r.affectedFiles}`);
  console.log(`affected unit tests .. ${r.affectedTestFiles}`);
  console.log(`unit test projects ... ${r.affectedTestProjects.length}${r.affectedTestProjects.length ? ':' : ''}`);
  r.affectedTestProjects.forEach((p) => console.log(`   • ${p}`));
  console.log(`e2e projects ......... ${r.affectedE2eProjects.length}${r.affectedE2eProjects.length ? ':' : ''}`);
  r.affectedE2eProjects.forEach((p) => console.log(`   • ${p}`));
  console.log(line);
  console.log('Run the affected tests:');
  if (r.affectedTestFiles) {
    console.log(`  # jest      : node tools/tia/tia.mjs --run --runner jest`);
    console.log(`  # vitest    : yarn vitest related $(node tools/tia/tia.mjs --json | jq -r '.tests[]')`);
    console.log(`  # rstest    : yarn rstest --changed --related ...  (feed .tests from tia-affected.json)`);
  }
  if (r.affectedE2eProjects.length) {
    console.log(`  # playwright: node tools/tia/tia.mjs --run --runner playwright`);
  }
  console.log(`  (full list written to tools/tia/tia-affected.json)`);
  console.log(line);
}

main();

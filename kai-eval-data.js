#!/usr/bin/env node
// =============================================================================
// kai-eval-data.js
// Language-agnostic project assessment data collector.
//
// Gathers generic information across 12 assessment scales:
//   Clean code, Design choices, Coding conventions control, Static analysis,
//   Testing, Code coverage control, Documentation, Git branching,
//   Bug and issue tracking, Code reviews, CI/CD, Releases
//
// Usage:  ./kai-eval-data.js [repo-root]
//         node kai-eval-data.js [repo-root]
// Safe to run anywhere; read-only; degrades gracefully when tools are absent.
//
// Design goals (output is intended to be fed to an LLM):
//   * Concise — no empty sections, no banners, capped file dumps, counts
//     instead of raw repeated lines.
//   * De-duplicated — each config file is dumped at most once; overlapping git
//     log views are merged into one.
//   * One-pass — a single file inventory + a single line-count pass feed
//     every size/structure heuristic; a single `git log` feeds every history
//     view.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- root & cwd -------------------------------------------------------------
const ROOT = process.argv[2] || '.';
try {
  process.chdir(ROOT);
} catch (e) {
  console.error(`cannot cd to ${ROOT}`);
  process.exit(1);
}

// --- helpers ----------------------------------------------------------------
function have(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Run a shell command, return stdout (string) or '' on failure.
function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// Recursive file walk (relative paths), excluding common dependency/VCS dirs.
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv']);

function walkFiles(dir, into, depth, maxDepth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      if (maxDepth != null && depth >= maxDepth) continue;
      walkFiles(full, into, depth + 1, maxDepth);
    } else if (e.isFile()) {
      into.push(full);
    }
  }
}

// Directory-only walk with per-dir maxDepth pruning for the structure tree.
const TREE_EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', '.venv', 'venv', 'target', 'build', 'dist',
]);
function walkDirs(dir, into, depth, maxDepth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  into.push(dir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (TREE_EXCLUDE_DIRS.has(e.name)) continue;
    if (depth >= maxDepth) continue;
    walkDirs(path.join(dir, e.name), into, depth + 1, maxDepth);
  }
}

// --- output buffering -------------------------------------------------------
const OUT = [];        // final output lines
let BUF = [];          // current section buffer
const DUMPED = new Set();

function sectionStart() { BUF = []; }

function sectionFlush(title) {
  if (BUF.length === 0) return;
  OUT.push('');
  OUT.push(`## ${title}`);
  OUT.push(...BUF);
}

// emit(label, body) — print a "--- label ---" header + body only if body is
// non-empty. Strips trailing blanks.
function emit(label, body) {
  if (body == null) return;
  body = String(body).replace(/\s+$/, '');
  if (body === '') return;
  BUF.push('');
  BUF.push(`--- ${label} ---`);
  BUF.push(body);
}

// dumpCfg(path) — print up to 40 lines of a file, once per path, with a
// truncation marker. Tracks seen paths so the same file is never shown twice
// across sections.
function dumpCfg(f) {
  if (!isFile(f)) return;
  if (DUMPED.has(f)) return;
  DUMPED.add(f);
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const total = lines.length;
  if (total > 40) {
    const head = lines.slice(0, 40).join('\n') + `\n… (truncated, ${total} total lines)`;
    emit(`${f} (head 40 of ${total})`, head);
  } else {
    emit(`${f} (${total} lines)`, lines.join('\n'));
  }
}

// lsOr(fallback, files) — list existing files, or print fallback only when
// nothing exists.
function lsOr(fallback, files) {
  const out = files.filter((f) => isFile(f) || isDir(f));
  if (out.length) return out.join('\n');
  return fallback;
}

// --- one-pass file inventory ------------------------------------------------
const allFiles = [];
walkFiles('.', allFiles, 0, null);
allFiles.sort();
const ALL_FILES = allFiles; // relative paths, sorted

// Source-file subset + a single line-count pass (feeds largest files, god
// files, avg size per extension, and the anti-pattern grep file list).
// Exclude the script itself so its own pattern strings/comments aren't scanned.
const SRC_RE = /\.(go|py|js|jsx|ts|tsx|java|kt|kts|c|cpp|cc|cxx|h|hpp|rs|rb|php|cs|scala|swift|m|mm|sh|bash|zsh|ps1|lua|pl|r|ex|exs|erl|clj|cljs|hs|ml|fs|vb|dart|groovy|el|lisp|scm)$/;
const SELF_BASE = path.basename(process.argv[1] || 'kai-eval-data.js');
const SRC_LIST = ALL_FILES.filter(
  (f) => SRC_RE.test(f) && path.basename(f) !== SELF_BASE
);

// Read each source file once: line count + full text (reused by counts()).
const SRC = SRC_LIST.map((f) => {
  let text = '';
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    text = '';
  }
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return { file: f, lines, text };
});

// WC_OUT: {lines, file} sorted desc by lines (no "total" row).
const WC_OUT = SRC.map((s) => ({ lines: s.lines, file: s.file }))
  .filter((o) => o.lines > 0)
  .sort((a, b) => b.lines - a.lines);

// counts(pattern, label) — per-file match counts collapsed to "file:count",
// top-N (20). Counts matching lines (like grep -Ec).
function counts(pat, label) {
  if (SRC_LIST.length === 0) return;
  let re;
  try {
    re = new RegExp(pat);
  } catch {
    return;
  }
  const rows = [];
  for (const s of SRC) {
    let c = 0;
    if (s.text) {
      for (const line of s.text.split('\n')) {
        if (re.test(line)) c++;
      }
    }
    if (c > 0) rows.push(`${s.file}:${c}`);
  }
  rows.sort((a, b) => {
    const ca = parseInt(a.slice(a.lastIndexOf(':') + 1), 10);
    const cb = parseInt(b.slice(b.lastIndexOf(':') + 1), 10);
    return cb - ca;
  });
  emit(`${label} (files:count)`, rows.slice(0, 20).join('\n'));
}

// ============================================================================
// 0. Project identity & technology detection
// ============================================================================
sectionStart();
{
  let top = [];
  try {
    top = fs.readdirSync('.', { withFileTypes: true })
      .map((e) => e.name)
      .sort();
  } catch {}
  emit('Top-level listing', top.join('\n'));
}
{
  const manifestRe = /(^|\/)(go\.mod|go\.sum|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|setup\.py|setup\.cfg|pyproject\.toml|requirements\.txt|Pipfile|poetry\.lock|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|.*\.csproj|.*\.sln|.*\.fsproj|packages\.config|Makefile|GNUmakefile|make\.bat|CMakeLists\.txt|configure\.ac|Dockerfile|docker-compose\.yml|docker-compose\.yaml|pubspec\.yaml|mix\.exs|rebar\.config)$/;
  emit('Manifests / build files', ALL_FILES.filter((f) => manifestRe.test(f)).join('\n'));
}
{
  const extCounts = {};
  for (const f of ALL_FILES) {
    const m = f.match(/\.([A-Za-z0-9]+)$/);
    if (!m) continue;
    const e = m[1].toLowerCase();
    extCounts[e] = (extCounts[e] || 0) + 1;
  }
  const rows = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([e, c]) => `${String(c).padStart(6)} ${e}`);
  emit('File type distribution (top 30 ext)', rows.join('\n'));
}
{
  const cfg = [];
  let entries = [];
  try {
    entries = fs.readdirSync('.', { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.') ||
        /\.(yml|yaml|toml|ini|cfg|json)$/.test(e.name)) {
      cfg.push('./' + e.name);
    }
  }
  cfg.sort();
  emit('Top-level dotfiles / config files', cfg.join('\n'));
}
sectionFlush('0. PROJECT IDENTITY & TECH DETECTION');

// ============================================================================
// 1. Git — log / branches / remote / tags
// ============================================================================
sectionStart();
if (have('git') && sh('git rev-parse --is-inside-work-tree').trim()) {
  emit('Recent log (last 30, hash|author|date|subject)',
    sh("git log --format='%h|%an|%ad|%s' --date=short -30").trim());
  emit('Branches (local + remote)', sh('git branch -a').trim());
  emit('Remotes', sh('git remote -v').trim());
  emit('Tags (last 20)',
    sh('git tag --sort=-creatordate').split('\n').slice(0, 20).join('\n').trim());
  emit('Recent merges (last 20)',
    sh('git log --oneline --merges -20').trim());
  emit('Author aggregate (shortlog)', sh('git shortlog -sne').trim());
  emit('First commit / repo age',
    sh("git log --reverse --format='%ad | %s' --date=short").split('\n')[0].trim());
  {
    const total = sh('git rev-list --count HEAD').trim() || '?';
    emit('Total commits', total);
  }
  {
    const def = sh('git symbolic-ref --short HEAD').trim() || 'main';
    const branches = sh('git branch -a')
      .split('\n')
      .map((b) => b.replace(/[* ]/g, '').trim())
      .filter(Boolean)
      .filter((b) => /(^|\/)(devel|develop|release\/|hotfix\/)/i.test(b));
    const rows = [];
    for (const b of branches) {
      const a = sh(`git rev-list --count ${def}..${b}`).trim() || '?';
      const c = sh(`git rev-list --count ${b}..${def}`).trim() || '?';
      rows.push(`${b.replace(/^remotes\/origin\//, '')} ahead=${a} behind=${c}`);
    }
    emit('Long-lived branch divergence vs default', rows.join('\n'));
  }
} else {
  emit('Git', '(not a git repo or git unavailable)');
}
sectionFlush('1. GIT — LOG / BRANCHES / REMOTE / TAGS');

// ============================================================================
// 2. Documentation
// ============================================================================
sectionStart();
{
  emit('Docs (md/rst/txt/adoc)',
    ALL_FILES.filter((f) => /\.(md|rst|txt|adoc)$/.test(f)).sort().join('\n'));
}
for (const r of ['README.md', 'README.rst', 'README.txt', 'README.MD', 'readme.md']) {
  if (!isFile(r)) continue;
  let text = '';
  try { text = fs.readFileSync(r, 'utf8'); } catch {}
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  emit(`${r} (head 25)`, lines.slice(0, 25).join('\n'));
  emit(`${r} headers`,
    lines.map((l, i) => (/^#{1,6} /.test(l) ? `${i + 1}:${l}` : null))
      .filter(Boolean).slice(0, 60).join('\n'));
}
{
  const rows = [];
  for (const g of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'CODEOWNERS']) {
    let found = '';
    for (const loc of [g, `.github/${g}`, `docs/${g}`]) {
      if (isFile(loc)) { found = loc; break; }
    }
    rows.push(`${g.padEnd(22)} ${found || 'missing'}`);
  }
  emit('Governance file checklist', rows.join('\n'));
}
sectionFlush('2. DOCUMENTATION');

// ============================================================================
// 3. Structure — directories & source inventory
// ============================================================================
sectionStart();
{
  const dirs = [];
  walkDirs('.', dirs, 0, 4);
  dirs.sort();
  emit('Directory tree (depth 4)', dirs.slice(0, 120).join('\n'));
}
{
  const extCounts = {};
  for (const f of SRC_LIST) {
    const m = f.match(/\.([A-Za-z0-9]+)$/);
    if (!m) continue;
    const e = m[1].toLowerCase();
    extCounts[e] = (extCounts[e] || 0) + 1;
  }
  const rows = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `${String(c).padStart(6)} ${e}`);
  emit('Source files by extension', rows.join('\n'));
}
{
  emit('Largest source files (top 15)',
    WC_OUT.slice(0, 16).map((o) => `${o.lines} ${o.file}`).join('\n'));
}
sectionFlush('3. STRUCTURE — DIRECTORIES & SOURCE INVENTORY');

// ============================================================================
// 4. Coding conventions control (linters / formatters / pre-commit)
// ============================================================================
sectionStart();
{
  const LINT_CFG = [
    '.golangci.yml', '.golangci.yaml', '.revive.toml', '.editorconfig', '.pre-commit-config.yaml',
    '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.cjs',
    '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.yml',
    'pyproject.toml', 'setup.cfg', '.flake8', '.pylintrc', '.ruff.toml', '.mypy.ini', 'mypy.ini',
    '.rubocop.yml', '.standard.yml', '.reek.yml', '.brakeman.yml',
    '.checkstyle.xml', '.spotbugs.xml', 'google_checks.xml', 'sun_checks.xml',
    '.clang-format', '.clang-tidy', '.cmake-format.py',
    '.stylelintrc', '.htmlhintrc', '.markdownlint.json', '.markdownlint.yaml',
    'biome.json', '.oxlintrc.json', 'deno.json',
    '.husky', '.lintstagedrc', '.lintstagedrc.json',
  ];
  for (const f of LINT_CFG) dumpCfg(f);
}
{
  const found = [];
  for (const d of ['.github', '.gitlab', '.circleci']) {
    if (!isDir(d)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isFile()) continue;
      found.push(path.join(d, e.name));
      if (e.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(path.join(d, e.name))) {
            found.push(path.join(d, e.name, sub));
          }
        } catch {}
      }
    }
  }
  found.sort();
  emit('.github / .gitlab / .circleci configs', found.join('\n'));
}
sectionFlush('4. CONVENTIONS — LINTER / FORMATTER / PRE-COMMIT CONFIGS');

// ============================================================================
// 5. Static analysis & security tooling
// ============================================================================
sectionStart();
{
  const SA_CFG = [
    '.gosec.yaml', '.gosec.yml', 'gosec.sarif',
    '.github/workflows/codeql.yml', '.github/workflows/codeql.yaml',
    '.semgrep.yml', 'semgrep.yml', '.semgrep.yaml', 'sast.config.yaml',
    '.bandit', 'bandit.yml', '.pylintrc',
    '.trivy.yaml', 'trivy.yaml', 'grype.yaml',
    '.snyk', 'snyk.txt',
    '.github/dependabot.yml', '.github/dependabot.yaml',
    '.codeclimate.yml', '.deepsource.toml', '.codacy.yml',
    'sonar-project.properties', '.sonarcloud.properties',
  ];
  for (const f of SA_CFG) dumpCfg(f);
}
{
  emit('SBOM / supply-chain files', lsOr('(none found)', []));
}
sectionFlush('5. STATIC ANALYSIS / SECURITY');

// ============================================================================
// 6. Testing & code coverage control
// ============================================================================
sectionStart();
{
  const TEST_RE = /(_test\.go$|_test\.py$|^test_.*\.py$|Test\.java$|_spec\.rb$|_spec\.(js|ts)$|\.spec\.(js|ts)$|\.bats$)/;
  const testFiles = ALL_FILES
    .map((f) => path.basename(f))
    .filter((b) => TEST_RE.test(b));
  testFiles.sort();
  emit('Test files', [...new Set(testFiles)].join('\n'));
}
{
  const TEST_RE = /(_test\.go$|_test\.py$|^test_.*\.py$|Test\.java$|_spec\.rb$|_spec\.(js|ts)$|\.spec\.(js|ts)$|\.bats$)/;
  const t = ALL_FILES.filter((f) => TEST_RE.test(path.basename(f))).length;
  const s = SRC_LIST.length;
  emit('Test vs source count', `test_files=${t} source_files=${s}`);
}
{
  const dirs = [];
  function walkTestDirs(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (/test|spec/i.test(e.name) || e.name === '__tests__') dirs.push(full);
      walkTestDirs(full, depth + 1);
    }
  }
  walkTestDirs('.', 0);
  dirs.sort();
  emit('Test/coverage dirs', dirs.slice(0, 40).join('\n'));
}
{
  const re = /\b(coverage|codecov|coveralls|cobertura|lcov|istanbul|covr|pytest-cov|jacoco)\b/i;
  const targets = ['.github', 'Makefile', 'pyproject.toml', 'setup.cfg', 'package.json', 'pom.xml', 'build.gradle', 'README.md'];
  const hits = new Set();
  for (const t of targets) {
    if (!isFile(t)) continue;
    let text = '';
    try { text = fs.readFileSync(t, 'utf8'); } catch {}
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) hits.add(`${t}:${i + 1}:${line.trim()}`);
    });
  }
  emit('Coverage tooling mentions', [...hits].sort().slice(0, 30).join('\n'));
}
{
  const hits = [];
  if (isFile('README.md')) {
    let text = '';
    try { text = fs.readFileSync('README.md', 'utf8'); } catch {}
    const re = /\b(coverage|codecov|coveralls)\b/i;
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${i + 1}:${line}`);
    });
  }
  emit('Coverage badges in README', hits.slice(0, 20).join('\n'));
}
sectionFlush('6. TESTING & COVERAGE');

// ============================================================================
// 7. CI/CD
// ============================================================================
sectionStart();
{
  const locs = [
    '.github/workflows', '.gitlab-ci', '.circleci/config.yml', '.woodpecker',
    '.drone.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml',
    'bitbucket-pipelines.yml', '.act', '.buildkite', 'appveyor.yml',
  ];
  emit('CI config locations', locs.filter((d) => exists(d)).join('\n'));
}
{
  const files = [];
  if (isDir('.github/workflows')) {
    try {
      for (const e of fs.readdirSync('.github/workflows')) {
        if (/\.ya?ml$/.test(e)) files.push(`.github/workflows/${e}`);
      }
    } catch {}
  }
  for (const f of files) dumpCfg(f);
}
{
  const counts = {};
  if (isDir('.github/workflows')) {
    try {
      for (const e of fs.readdirSync('.github/workflows')) {
        const f = `.github/workflows/${e}`;
        if (!isFile(f)) continue;
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch {}
        for (const line of text.split('\n')) {
          const m = line.match(/^\s*uses:\s*(\S+)/);
          if (m) {
            const u = m[1].replace(/ #.*$/, '');
            counts[u] = (counts[u] || 0) + 1;
          }
        }
      }
    } catch {}
  }
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([u, c]) => `${String(c).padStart(6)} ${u}`);
  emit('GitHub Actions used', rows.join('\n'));
}
{
  const hits = [];
  if (isDir('.github')) {
    function scanCi(dir) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          let text = '';
          try { text = fs.readFileSync(full, 'utf8'); } catch {}
          text.split('\n').forEach((line, i) => {
            if (/uses: .+@/.test(line) && !/@(v[0-9]+|main|master|latest)/.test(line)) {
              hits.push(`${full}:${i + 1}:${line.trim()}`);
            }
          });
        } else if (e.isDirectory()) scanCi(full);
      }
    }
    scanCi('.github');
  }
  emit('Unpinned or non-versioned actions', hits.slice(0, 20).join('\n'));
}
sectionFlush('7. CI/CD');

// ============================================================================
// 8. Releases / changelog / publishing
// ============================================================================
sectionStart();
{
  const RELEASE_CFG = [
    '.goreleaser.yaml', '.goreleaser.yml', 'release.config.json', '.release-it.json', '.release-it.yaml',
    '.github/release.yml', '.github/release-drafter.yml',
    '.changeset', '.changesets/config.json', '.changeset/config.json',
    '.standard-version', '.cz.toml', '.versionrc', '.versionrc.json', 'commitlint.config.js',
    'CHANGELOG.md', 'CHANGELOG.rst', 'HISTORY.md', 'CHANGES.md', 'NEWS.md',
    'snapcraft.yaml', 'AppImageBuilder.yml',
    '.npmrc', '.pypirc', '.maven-settings.xml',
  ];
  for (const f of RELEASE_CFG) dumpCfg(f);
}
{
  const files = ['VERSION', 'version.txt', '.version', 'package.json', 'pyproject.toml', 'setup.py',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];
  emit('Version files present', files.filter((f) => isFile(f)).join('\n'));
}
{
  emit('Latest tag (git describe)',
    sh('git describe --tags --abbrev=0').trim() || '(no tags)');
}
sectionFlush('8. RELEASES / CHANGELOG / PUBLISHING');

// ============================================================================
// 9. Bug & issue tracking / governance
// ============================================================================
sectionStart();
{
  const found = [];
  for (const d of ['.github/ISSUE_TEMPLATE', '.gitlab/issue_templates']) {
    if (!isDir(d)) continue;
    try {
      for (const e of fs.readdirSync(d)) found.push(`${d}/${e}`);
    } catch {}
  }
  found.sort();
  emit('Issue templates', found.join('\n'));
}
{
  let templates = [];
  try {
    if (isDir('.github/ISSUE_TEMPLATE')) {
      templates = fs.readdirSync('.github/ISSUE_TEMPLATE').map((f) => `.github/ISSUE_TEMPLATE/${f}`);
    }
  } catch {}
  for (const f of templates) dumpCfg(f);
}
{
  emit('PR templates', lsOr('(no PR templates)', []));
}
{
  const rows = [];
  for (const f of ['.github/FUNDING.yml', '.github/stale.yml', '.github/no-response.yml', '.github/config.yml']) {
    if (isFile(f)) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch {}
      rows.push(`--- ${f} ---\n${text}`.replace(/\s+$/, ''));
    }
  }
  if (!isFile('.github/FUNDING.yml')) rows.push('(no FUNDING.yml)');
  emit('Funding / bot configs', rows.join('\n'));
}
sectionFlush('9. ISSUES & GOVERNANCE');

// ============================================================================
// 10. Code reviews
// ============================================================================
sectionStart();
{
  if (isFile('.github/auto_assign.yml')) {
    let text = '';
    try { text = fs.readFileSync('.github/auto_assign.yml', 'utf8'); } catch {}
    emit('Auto-assign / reviewers config', text);
  } else {
    emit('Auto-assign / reviewers config', '(no auto_assign.yml)');
  }
}
{
  const parts = [];
  for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    if (isFile(f)) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch {}
      parts.push(text);
    }
  }
  emit('CODEOWNERS', parts.length ? parts.join('\n') : '(no CODEOWNERS)');
}
{
  const log = sh("git log --format='%s %b' -100");
  const hits = log.split('\n')
    .filter((l) => /Co-authored-by|Reviewed-by|LGTM|approves?/i.test(l))
    .slice(0, 20);
  emit('Review-trail tags in recent commits (last 100)', hits.join('\n'));
}
sectionFlush('10. CODE REVIEWS');

// ============================================================================
// 11. Clean code / design heuristics
// ============================================================================
sectionStart();
counts('TODO|FIXME|XXX|HACK|BUG|DEPRECATED|NOQA', 'Anti-pattern markers');
counts('os\\.Exit|panic\\(|System\\.exit|exit\\(|abort\\(|die\\(', 'Hard exit / abort calls');
counts('fmt\\.Print|println!|console\\.log|System\\.out\\.print', 'stdout print statements');
{
  // God files: largest source file per directory.
  const best = {}; // dir -> {lines, file}
  for (const o of WC_OUT) {
    let d = o.file.replace(/[^/]*$/, '');
    if (d === '') d = './';
    if (!best[d] || o.lines > best[d].lines) best[d] = { lines: o.lines, file: o.file };
  }
  const rows = Object.entries(best)
    .map(([, v]) => `${v.lines} ${v.file}`)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .slice(0, 20);
  emit('Possible God files (largest per dir, top 20)', rows.join('\n'));
}
{
  const baseCounts = {};
  for (const f of ALL_FILES) {
    const b = path.basename(f);
    baseCounts[b] = (baseCounts[b] || 0) + 1;
  }
  const dup = Object.entries(baseCounts)
    .filter(([, c]) => c > 1)
    .map(([b]) => b)
    .filter((b) => !/^(main\.go|index\.js|index\.ts|README\.md|package\.json|go\.mod|go\.sum|Makefile|\.gitignore)$/.test(b))
    .sort()
    .slice(0, 20);
  emit('Duplicate basenames across dirs', dup.join('\n'));
}
{
  const cnt = {}, sum = {};
  for (const o of WC_OUT) {
    const m = o.file.match(/\.([A-Za-z0-9]+)$/);
    if (!m) continue;
    const e = m[1].toLowerCase();
    cnt[e] = (cnt[e] || 0) + 1;
    sum[e] = (sum[e] || 0) + o.lines;
  }
  const rows = Object.entries(cnt)
    .map(([e, c]) => `  .${e.padEnd(6)} files=${String(c).padEnd(5)} avg=${Math.floor(sum[e] / c)}`)
    .sort();
  emit('Avg source file size per extension', rows.join('\n'));
}
sectionFlush('11. CLEAN CODE / DESIGN HEURISTICS');

// ============================================================================
// 12. Dependency manifests
// ============================================================================
sectionStart();
{
  const DEP_FILES = [
    'go.mod', 'package.json', 'yarn.lock', 'pnpm-lock.yaml', 'pom.xml', 'build.gradle',
    'build.gradle.kts', 'settings.gradle', 'setup.py', 'setup.cfg', 'pyproject.toml',
    'requirements.txt', 'Pipfile', 'Cargo.toml', 'Gemfile', 'Gemfile.lock', 'composer.json',
    'packages.config',
  ];
  for (const f of DEP_FILES) dumpCfg(f);
}
{
  emit('Lockfiles present (supply-chain hygiene)', lsOr('(no lockfiles)', [
    'go.sum', 'yarn.lock', 'pnpm-lock.yaml', 'package-lock.json',
    'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'gradle.lock',
    'verification-metadata.xml',
  ]));
}
sectionFlush('12. DEPENDENCIES (manifest heads)');

// ============================================================================
OUT.push('');
OUT.push('## ASSESSMENT DATA COLLECTION COMPLETE');
process.stdout.write(OUT.join('\n') + '\n');

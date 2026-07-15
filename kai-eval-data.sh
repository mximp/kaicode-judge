#!/usr/bin/env bash
# =============================================================================
# kai-eval.sh
# Language-agnostic project assessment data collector.
#
# Gathers generic information across 12 assessment scales:
#   Clean code, Design choices, Coding conventions control, Static analysis,
#   Testing, Code coverage control, Documentation, Git branching,
#   Bug and issue tracking, Code reviews, CI/CD, Releases
#
# Usage:  ./kai-eval.sh [repo-root]
# Safe to run anywhere; read-only; degrades gracefully when tools are absent.
#
# Design goals (output is intended to be fed to an LLM):
#   * Concise — no empty sections, no banners, capped file dumps, counts
#     instead of raw repeated lines.
#   * De-duplicated — each config file is dumped at most once; overlapping git
#     log views are merged into one.
#   * One-pass — a single `find` inventory + a single `wc -l` pass feed every
#     size/structure heuristic; a single `git log` feeds every history view.
# =============================================================================

set -u
ROOT="${1:-.}"
cd "$ROOT" || { echo "cannot cd to $ROOT"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- temp files & cleanup ---------------------------------------------------
OUT=$(mktemp); BUF=$(mktemp)
ALL_FILES=$(mktemp); SRC_LIST=$(mktemp); WC_OUT=$(mktemp)
declare -A DUMPED=()
trap 'rm -f "$OUT" "$BUF" "$ALL_FILES" "$SRC_LIST" "$WC_OUT"' EXIT

# --- output helpers ---------------------------------------------------------
# A section is buffered into $BUF and only emitted if it has content, so empty
# sections produce no output at all (saves tokens for sparse repos).
section_start() { : > "$BUF"; }
section_flush() {
  [ -s "$BUF" ] || return 0
  printf '\n## %s\n' "$1" >> "$OUT"
  cat "$BUF" >> "$OUT"
}

# emit <label> <stdin>  — print a "--- label ---" header + body only if body
# is non-empty. Strips trailing blanks.
emit() {
  local label="$1" body
  body=$(cat)
  [ -n "$body" ] || return 0
  printf '\n--- %s ---\n%s\n' "$label" "$body" >> "$BUF"
}

# dump_cfg <path>  — print up to 40 lines of a file, once per path, with a
# truncation marker. Tracks seen paths in DUMPED[] so the same file is never
# shown twice across sections (e.g. codeql.yml in both security & CI).
dump_cfg() {
  local f="$1" total
  [ -f "$f" ] || return 0
  [ -z "${DUMPED[$f]:-}" ] || return 0
  DUMPED[$f]=1
  total=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$total" -gt 40 ]; then
    { sed -n '1,40p' "$f"; printf '… (truncated, %s total lines)\n' "$total"; } \
      | emit "$f (head 40 of $total)"
  else
    cat "$f" | emit "$f ($total lines)"
  fi
}

# ls_or <fallback> <files...>  — list existing files, or print fallback only
# when nothing exists. Avoids the `ls a b c || echo none` trap where ls exits
# non-zero (because some args are missing) and prints the fallback even though
# some files were found.
ls_or() {
  local fb="$1"; shift
  local out
  out=$(ls -1 "$@" 2>/dev/null)
  [ -n "$out" ] && printf '%s\n' "$out" || echo "$fb"
}

# --- one-pass file inventory ------------------------------------------------
# Single `find` walk feeds: manifest detection, extension histogram, source
# inventory, test-file heuristic, duplicate basenames, largest/god files.
find . -type f \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
  -not -path '*/.venv/*'  -not -path '*/venv/*' \
  2>/dev/null | sort > "$ALL_FILES"

# Source-file subset + a single wc -l pass (feeds largest files, god files,
# avg size per extension, and the anti-pattern grep file list).
# Exclude the script itself so its own pattern strings/comments aren't scanned.
SRC_RE='\.(go|py|js|jsx|ts|tsx|java|kt|kts|c|cpp|cc|cxx|h|hpp|rs|rb|php|cs|scala|swift|m|mm|sh|bash|zsh|ps1|lua|pl|r|ex|exs|erl|clj|cljs|hs|ml|fs|vb|dart|groovy|el|lisp|scm)$'
SELF_BASE="$(basename "$0")"
grep -E "$SRC_RE" "$ALL_FILES" | grep -vE "(^|/)$SELF_BASE$" > "$SRC_LIST" 2>/dev/null || :
if [ -s "$SRC_LIST" ]; then
  xargs -d '\n' -r wc -l < "$SRC_LIST" 2>/dev/null \
    | grep -vE ' total$' | sort -rn > "$WC_OUT"
fi

# Reusable: per-file match counts collapsed to "file:count" top-N.
# counts <pattern> <label> [extra grep opts...]
counts() {
  local pat="$1" label="$2"; shift 2
  [ -s "$SRC_LIST" ] || return 0
  xargs -d '\n' -r grep -Ec "$@" -- "$pat" < "$SRC_LIST" 2>/dev/null \
    | awk -F: '$2>0 {print}' | sort -t: -k2 -rn | head -20 \
    | emit "$label (files:count)"
}

# ============================================================================
# 0. Project identity & technology detection
# ============================================================================
section_start
emit "Top-level listing" < <(ls -1A)

emit "Manifests / build files" < <(
  grep -E '(^|/)(go\.mod|go\.sum|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|setup\.py|setup\.cfg|pyproject\.toml|requirements\.txt|Pipfile|poetry\.lock|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|.*\.csproj|.*\.sln|.*\.fsproj|packages\.config|Makefile|GNUmakefile|make\.bat|CMakeLists\.txt|configure\.ac|Dockerfile|docker-compose\.yml|docker-compose\.yaml|pubspec\.yaml|mix\.exs|rebar\.config)$' "$ALL_FILES"
)

emit "File type distribution (top 30 ext)" < <(
  sed -nE 's/.*\.([A-Za-z0-9]+)$/\1/p' "$ALL_FILES" | tr 'A-Z' 'a-z' \
    | sort | uniq -c | sort -rn | head -30
)

emit "Top-level dotfiles / config files" < <(
  find . -maxdepth 1 -type f \( -name ".*" -o -name "*.yml" -o -name "*.yaml" \
    -o -name "*.toml" -o -name "*.ini" -o -name "*.cfg" -o -name "*.json" \) \
    -not -path '*/.git/*' 2>/dev/null | sort
)
section_flush "0. PROJECT IDENTITY & TECH DETECTION"

# ============================================================================
# 1. Git — log / branches / remote / tags
# ============================================================================
section_start
if have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # One rich log feeds the recent-log view; merges are a separate (filtered)
  # view kept here only. Author aggregates come from `git shortlog`.
  emit "Recent log (last 30, hash|author|date|subject)" < <(
    git log --format='%h|%an|%ad|%s' --date=short -30 2>/dev/null
  )
  emit "Branches (local + remote)" < <(git branch -a 2>/dev/null)
  emit "Remotes" < <(git remote -v 2>/dev/null)
  emit "Tags (last 20)" < <(
    git tag --sort=-creatordate 2>/dev/null | head -20
  )
  emit "Recent merges (last 20)" < <(
    git log --oneline --merges -20 2>/dev/null
  )
  emit "Author aggregate (shortlog)" < <(git shortlog -sne 2>/dev/null)
  emit "First commit / repo age" < <(
    git log --reverse --format='%ad | %s' --date=short 2>/dev/null | head -1
  )
  emit "Total commits" < <(git rev-list --count HEAD 2>/dev/null || echo "?")
  emit "Long-lived branch divergence vs default" < <(
    def=$(git symbolic-ref --short HEAD 2>/dev/null || echo main)
    git branch -a 2>/dev/null | sed 's/[* ]//g' \
      | grep -iE '(^|/)(devel|develop|release/|hotfix/)' \
      | while read -r b; do
          a=$(git rev-list --count "$def..$b" 2>/dev/null || echo "?")
          c=$(git rev-list --count "$b..$def" 2>/dev/null || echo "?")
          printf '%s ahead=%s behind=%s\n' "${b#remotes/origin/}" "$a" "$c"
        done
  )
else
  emit "Git" <<< "(not a git repo or git unavailable)"
fi
section_flush "1. GIT — LOG / BRANCHES / REMOTE / TAGS"

# Note: `git fetch --prune --dry-run` was removed — it is a network call
# (slow, fails offline) and adds little beyond `git branch -a` above.

# ============================================================================
# 2. Documentation
# ============================================================================
section_start
emit "Docs (md/rst/txt/adoc)" < <(
  grep -E '\.(md|rst|txt|adoc)$' "$ALL_FILES" | sort
)
# README: compact head + real headers only (no list bullets / all-caps lines).
for r in README.md README.rst README.txt README.MD readme.md; do
  [ -f "$r" ] || continue
  emit "$r (head 25)" < <(sed -n '1,25p' "$r")
  emit "$r headers" < <(grep -nE '^#{1,6} ' "$r" 2>/dev/null | head -60)
done
emit "Governance file checklist" < <(
  for g in CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md CHANGELOG.md LICENSE CODEOWNERS; do
    found=$(ls "$g" ".github/$g" "docs/$g" 2>/dev/null | head -1)
    printf '%-22s %s\n' "$g" "${found:-missing}"
  done
)
section_flush "2. DOCUMENTATION"

# ============================================================================
# 3. Structure — directories & source inventory
# ============================================================================
section_start
emit "Directory tree (depth 4)" < <(
  find . -type d -not -path '*/.git/*' -not -path '*/.git' \
    -not -path '*/node_modules/*' -not -path '*/vendor/*' \
    -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/target/*' \
    -not -path '*/build/*' -not -path '*/dist/*' 2>/dev/null | sort | head -120
)
emit "Source files by extension" < <(
  sed -nE 's/.*\.([A-Za-z0-9]+)$/\1/p' "$SRC_LIST" | tr 'A-Z' 'a-z' \
    | sort | uniq -c | sort -rn
)
emit "Largest source files (top 15)" < <(head -16 "$WC_OUT" 2>/dev/null)
section_flush "3. STRUCTURE — DIRECTORIES & SOURCE INVENTORY"

# ============================================================================
# 4. Coding conventions control (linters / formatters / pre-commit)
# ============================================================================
section_start
LINT_CFG=(
  .golangci.yml .golangci.yaml .revive.toml .editorconfig .pre-commit-config.yaml
  .eslintrc .eslintrc.js .eslintrc.json .eslintrc.yml .eslintrc.cjs
  .prettierrc .prettierrc.json .prettierrc.js .prettierrc.yml
  pyproject.toml setup.cfg .flake8 .pylintrc .ruff.toml .mypy.ini mypy.ini
  .rubocop.yml .standard.yml .reek.yml .brakeman.yml
  .checkstyle.xml .spotbugs.xml google_checks.xml sun_checks.xml
  .clang-format .clang-tidy .cmake-format.py
  .stylelintrc .htmlhintrc .markdownlint.json .markdownlint.yaml
  biome.json .oxlintrc.json deno.json
  .husky .lintstagedrc .lintstagedrc.json
)
for f in "${LINT_CFG[@]}"; do dump_cfg "$f"; done
emit ".github / .gitlab / .circleci configs" < <(
  find .github .gitlab .circleci -maxdepth 2 -type f 2>/dev/null | sort
)
section_flush "4. CONVENTIONS — LINTER / FORMATTER / PRE-COMMIT CONFIGS"

# ============================================================================
# 5. Static analysis & security tooling
# ============================================================================
section_start
SA_CFG=(
  .gosec.yaml .gosec.yml gosec.sarif
  .github/workflows/codeql.yml .github/workflows/codeql.yaml
  .semgrep.yml semgrep.yml .semgrep.yaml sast.config.yaml
  .bandit bandit.yml .pylintrc
  .trivy.yaml trivy.yaml grype.yaml
  .snyk snyk.txt
  .github/dependabot.yml .github/dependabot.yaml
  .codeclimate.yml .deepsource.toml .codacy.yml
  sonar-project.properties .sonarcloud.properties
)
for f in "${SA_CFG[@]}"; do dump_cfg "$f"; done
emit "SBOM / supply-chain files" < <(
  ls_or "(none found)" .github/workflows/*sbom* .github/workflows/*dependency* \
        spdx*.json sbom*.json .github/dependency-graph*
)
section_flush "5. STATIC ANALYSIS / SECURITY"

# ============================================================================
# 6. Testing & code coverage control
# ============================================================================
section_start
# Test-file heuristic via basename regex on the cached inventory.
TEST_RE='(_test\.go$|_test\.py$|^test_.*\.py$|Test\.java$|_spec\.rb$|_spec\.(js|ts)$|\.spec\.(js|ts)$|\.bats$)'
emit "Test files" < <(
  awk -F/ '{print $NF}' "$ALL_FILES" 2>/dev/null | grep -E "$TEST_RE" | sort -u
)
emit "Test vs source count" < <(
  t=$(awk -F/ '{print $NF}' "$ALL_FILES" 2>/dev/null | grep -cE "$TEST_RE")
  s=$(wc -l < "$SRC_LIST" 2>/dev/null || echo 0)
  printf 'test_files=%s source_files=%s\n' "$t" "$s"
)
emit "Test/coverage dirs" < <(
  find . -type d \( -iname "*test*" -o -iname "*spec*" -o -iname "__tests__" \) \
    -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
    2>/dev/null | sort | head -40
)
emit "Coverage tooling mentions" < <(
  grep -rniE '\b(coverage|codecov|coveralls|cobertura|lcov|istanbul|covr|pytest-cov|jacoco)\b' \
    .github Makefile pyproject.toml setup.cfg package.json pom.xml build.gradle \
    README.md 2>/dev/null | sort -u | head -30 || true
)
emit "Coverage badges in README" < <(
  grep -niE '\b(coverage|codecov|coveralls)\b' README.md 2>/dev/null | head -20 || true
)
section_flush "6. TESTING & COVERAGE"

# ============================================================================
# 7. CI/CD
# ============================================================================
section_start
emit "CI config locations" < <(
  for d in .github/workflows .gitlab-ci .circleci/config.yml .woodpecker \
           .drone.yml azure-pipelines.yml Jenkinsfile .travis.yml \
           bitbucket-pipelines.yml .act .buildkite appveyor.yml; do
    [ -e "$d" ] && echo "$d"
  done
)
# Workflow files dumped via dump_cfg → deduped with §5 (codeql.yml shown once).
for f in .github/workflows/*.yml .github/workflows/*.yaml; do dump_cfg "$f"; done
emit "GitHub Actions used" < <(
  grep -rhE '^[[:space:]]*uses:' .github/workflows 2>/dev/null \
    | sed -E 's/.*uses:[[:space:]]*//; s/ #.*//' | sort | uniq -c | sort -rn
)
emit "Unpinned or non-versioned actions" < <(
  grep -rEn "uses: .+@" .github 2>/dev/null \
    | grep -vE "@(v[0-9]+|main|master|latest)" | head -20 || true
)
section_flush "7. CI/CD"

# ============================================================================
# 8. Releases / changelog / publishing
# ============================================================================
section_start
RELEASE_CFG=(
  .goreleaser.yaml .goreleaser.yml release.config.json .release-it.json .release-it.yaml
  .github/release.yml .github/release-drafter.yml
  .changeset .changesets/config.json .changeset/config.json
  .standard-version .cz.toml .versionrc .versionrc.json commitlint.config.js
  CHANGELOG.md CHANGELOG.rst HISTORY.md CHANGES.md NEWS.md
  snapcraft.yaml AppImageBuilder.yml
  .npmrc .pypirc .maven-settings.xml
)
for f in "${RELEASE_CFG[@]}"; do dump_cfg "$f"; done
emit "Version files present" < <(
  ls -1 VERSION version.txt .version package.json pyproject.toml setup.py \
        Cargo.toml go.mod pom.xml build.gradle 2>/dev/null || true
)
emit "Latest tag (git describe)" < <(
  git describe --tags --abbrev=0 2>/dev/null || echo "(no tags)"
)
section_flush "8. RELEASES / CHANGELOG / PUBLISHING"

# ============================================================================
# 9. Bug & issue tracking / governance
# ============================================================================
section_start
emit "Issue templates" < <(
  find .github/ISSUE_TEMPLATE .gitlab/issue_templates -type f 2>/dev/null | sort
)
for f in .github/ISSUE_TEMPLATE/*; do dump_cfg "$f"; done
emit "PR templates" < <(
  ls_or "(no PR templates)" .github/pull_request_template* \
        .github/PULL_REQUEST_TEMPLATE* .gitlab/merge_request_templates/*
)
emit "Funding / bot configs" < <(
  for f in .github/FUNDING.yml .github/stale.yml .github/no-response.yml .github/config.yml; do
    [ -f "$f" ] && { echo "--- $f ---"; cat "$f"; }
  done
  [ -f .github/FUNDING.yml ] || echo "(no FUNDING.yml)"
)
section_flush "9. ISSUES & GOVERNANCE"

# ============================================================================
# 10. Code reviews
# ============================================================================
section_start
emit "Auto-assign / reviewers config" < <(
  cat .github/auto_assign.yml 2>/dev/null || echo "(no auto_assign.yml)"
)
emit "CODEOWNERS" < <(
  cat .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS 2>/dev/null \
    || echo "(no CODEOWNERS)"
)
emit "Review-trail tags in recent commits (last 100)" < <(
  git log --format='%s %b' -100 2>/dev/null \
    | grep -iE "Co-authored-by|Reviewed-by|LGTM|approves?" | head -20 || true
)
section_flush "10. CODE REVIEWS"

# ============================================================================
# 11. Clean code / design heuristics
# ============================================================================
section_start
# Collapsed to per-file counts (was 30+ raw lines, mostly identical os.Exit).
counts 'TODO|FIXME|XXX|HACK|BUG|DEPRECATED|NOQA' "Anti-pattern markers"
counts 'os\.Exit|panic\(|System\.exit|exit\(|abort\(|die\(' "Hard exit / abort calls"
counts 'fmt\.Print|println!|console\.log|System\.out\.print' "stdout print statements"

emit "Possible God files (largest per dir, top 20)" < <(
  awk '
    {n=$1; $1=""; sub(/^ +/,""); f=$0
     d=f; sub(/[^/]*$/,"",d); if(d=="") d="./"
     if(n+0 > best[d]+0){best[d]=n; file[d]=f}}
    END{for(d in best) printf "%d %s\n", best[d], file[d]}' "$WC_OUT" \
    | sort -rn | head -20
)
emit "Duplicate basenames across dirs" < <(
  awk -F/ '{print $NF}' "$ALL_FILES" | sort | uniq -d \
    | grep -vE '^(main\.go|index\.js|index\.ts|README\.md|package\.json|go\.mod|go\.sum|Makefile|\.gitignore)$' \
    | head -20
)
emit "Avg source file size per extension" < <(
  awk '
    {n=$1; $1=""; sub(/^ +/,""); f=$0
     if(match(f,/\.[A-Za-z0-9]+$/)){
       e=tolower(substr(f,RSTART+1,RLENGTH-1)); cnt[e]++; sum[e]+=n}}
    END{for(e in cnt) printf "  .%-6s files=%-5d avg=%d\n", e, cnt[e], int(sum[e]/cnt[e])}' \
    "$WC_OUT" | sort
)
section_flush "11. CLEAN CODE / DESIGN HEURISTICS"

# ============================================================================
# 12. Dependency manifests
# ============================================================================
section_start
DEP_FILES=(go.mod package.json yarn.lock pnpm-lock.yaml pom.xml build.gradle \
           build.gradle.kts settings.gradle setup.py setup.cfg pyproject.toml \
           requirements.txt Pipfile Cargo.toml Gemfile Gemfile.lock composer.json \
           packages.config)
for f in "${DEP_FILES[@]}"; do dump_cfg "$f"; done
emit "Lockfiles present (supply-chain hygiene)" < <(
  ls_or "(no lockfiles)" go.sum yarn.lock pnpm-lock.yaml package-lock.json \
        Cargo.lock poetry.lock Gemfile.lock composer.lock gradle.lock \
        verification-metadata.xml
)
section_flush "12. DEPENDENCIES (manifest heads)"

# ============================================================================
printf '\n## ASSESSMENT DATA COLLECTION COMPLETE\n' >> "$OUT"
cat "$OUT"

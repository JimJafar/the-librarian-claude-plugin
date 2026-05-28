# Releasing the Claude plugin

This is the per-repo release file. The full cross-family runbook
(branching strategy, semver rules, version-coordination across the
plugin family) lives in the monorepo at
[`the-librarian/docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).
Read that first if you're new to releases here.

## When to cut a release

Any merged PR that's user-visible (new slash command, new MCP tool
plumbing, hook behaviour change, bundle layout change, install /
config change) earns a release. Internal-only refactors, test-only
changes, and CI-only changes don't.

A coordinated cross-repo change (where this repo and one or more
sibling plugin repos ship in lockstep with a monorepo change) ships
at the **same MINOR version** as the monorepo. PATCH numbers drift
freely.

## Semver, the short version

- **MAJOR** — slash-command name removed/renamed, hook signature break,
  bundle entry point break.
- **MINOR** — new slash command, new hook, additive bundle entry,
  new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change.

## Steps

```sh
cd ~/code/the-librarian-claude-plugin
git checkout main && git pull

# 1. Bump the THREE version files in lockstep.
NEW=<X.Y.Z>
jq ".version = \"$NEW\"" .claude-plugin/plugin.json > tmp && mv tmp .claude-plugin/plugin.json
jq "(.plugins[] | select(.name == \"the-librarian\")).version = \"$NEW\"" .claude-plugin/marketplace.json > tmp && mv tmp .claude-plugin/marketplace.json
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json

# 2. Move CHANGELOG [Unreleased] entries under [vX.Y.Z] - YYYY-MM-DD.
$EDITOR CHANGELOG.md

# 3. Branch, commit, PR
git checkout -b release/v$NEW
git add -A
git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"

# 4. After CI green + merge
git checkout main && git pull
git tag -a v$NEW -m "v$NEW"
git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

Users pick it up by running `/plugin update the-librarian` in Claude
Code — no marketplace action needed. Claude reads
`.claude-plugin/marketplace.json` from the default branch on demand.

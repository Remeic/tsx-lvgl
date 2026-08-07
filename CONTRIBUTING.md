# Contributing to TSX-LVGL

TSX-LVGL uses an issue-first workflow. A feature starts as a GitHub issue, the issue is the work item, and the pull request closes it only after its acceptance criteria are evidenced.

## Feature workflow

1. Open a feature issue before writing implementation code.
2. Fill in the problem, scope, architecture diagram, acceptance criteria and test plan.
3. Discuss and adjust the interface/seam in the issue.
4. Implement on a branch named `feat/<short-name>` or `fix/<short-name>`.
5. Open a pull request linked to the issue.
6. Check every acceptance criterion with a test, screenshot, build log or hardware record.

Create a feature issue from the repository with:

```bash
gh issue create --template feature.md --label feature
```

## Commit messages

Commits follow this exact form:

```text
<type>(<scope>): <imperative lowercase subject>
```

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `chore`, `perf`, `revert`.

Allowed scopes: `core`, `compiler`, `emitter`, `runtime`, `board`, `simulator`, `docs`, `ci`, `deps`, `tooling`, `repo`, `release`.

Examples:

```text
feat(compiler): emit deterministic LVGL C

Refs #12
```

```text
test(core): cover nested view children
```

Rules are enforced by the versioned hook in `.githooks/commit-msg`. `feat` commits must reference a GitHub issue with `Refs #N`, `Closes #N` or `Fixes #N`. The hook is installed automatically by `npm install` and can be installed explicitly with `npm run setup-hooks`.

## Pull requests

Every pull request must link an issue, describe the acceptance-criteria evidence and state whether hardware or recovery behavior is affected. Keep generated firmware, full-flash dumps and credentials out of Git.

The default branch is intended to be protected: changes land through a pull request with the required CI checks and CODEOWNERS review. Direct pushes are reserved for repository bootstrap or an explicitly documented recovery action.

## Testing expectations

Use [the layered testing strategy](docs/feature-specs/0002-testing-and-mutation-strategy.md) to choose evidence. Do not claim hardware confidence from host tests alone, and do not use code coverage as a substitute for mutation or behavior evidence.

### Local validation fallback

Use the repository-pinned Node 24.19.0 and npm 11.17.0 toolchain. The public
commands remove and re-emit `test-dist/` before discovering tests, so ignored
output left by a branch switch cannot enter current evidence. They do not remove
package `dist/` outputs.

- `npm run check:fast` builds and runs the current tests for normal iteration.
- `npm test` builds and runs the current tests with the required coverage thresholds.
- `npm run mutation` prepares current test output once, then runs mutation testing.
- `npm run check:full` runs coverage and exactly one mutation pass. It is the slow pre-PR check.
- `npm run validation:context` prints deterministic JSON with the exact Git SHA,
  dirty state, provenance source, Node version and npm version.

Inside `./tools/dev`, the wrapper passes only the host SHA and dirty state into
the container. This supports linked worktrees without mounting shared Git
metadata; `gitSource: "environment"` identifies that validated host snapshot.

When hosted GitHub Actions cannot start, run the local ladder and attach its
exact-SHA evidence. A hosted-CI failure with zero executed steps is evidence
that the hosted infrastructure was unavailable; it is not evidence of a
product test failure. It also does not make local evidence equivalent to a
hosted run.

Use this template in a pull request or agent report:

```text
Validation context: <paste the complete `npm run validation:context` JSON>
npm run check:fast: PASS | FAIL | NOT RUN
npm test: PASS | FAIL | NOT RUN
npm run check:full: PASS | FAIL | NOT RUN
Hosted CI: PASS | FAIL after test execution | UNAVAILABLE (zero steps)
Simulator evidence: PASS | FAIL | NOT RUN
Physical board evidence: PASS | FAIL | NOT RUN
Recovery evidence: PASS | FAIL | NOT RUN
```

The local check commands above are host-software evidence only. Record
simulator, physical display/touch/power/reset, and recovery results separately;
none can be inferred from build, coverage, or mutation success.

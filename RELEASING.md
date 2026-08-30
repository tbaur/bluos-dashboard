# Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, and GitHub Releases are derived from commit messages — none are edited or run by hand.

This project is a local LAN dashboard (not published to PyPI or npm). A release is the git tag + GitHub Release notes only.

## Flow

1. A branch is created and changes are committed.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix | Example | Version bump |
   |---|---|---|
   | `fix:` | `fix: stabilize mute slider updates` | patch |
   | `feat:` | `feat: add multi-room group create` | minor |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: require Node 22` | major |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

3. The **Tests** (and CodeQL) workflows run on the PR. The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`. It bumps versions in `.release-please-manifest.json`, `backend`/`frontend` package metadata, and appends to `CHANGELOG.md`. Multiple code PRs merged before a release are batched into one Release PR.
5. Merging the Release PR triggers `release.yml` again, which creates the `vX.Y.Z` git tag and publishes a GitHub Release.

A release therefore reduces to: merge the code PR(s), approve the Release PR's checks, then merge the Release PR.

To force a version (for example **1.0.0** instead of the next 0.x minor), put this footer on the squash-merged commit:

```
Release-As: 1.0.0
```

release-please then retitles the Release PR to that version. Do not hand-edit `.release-please-manifest.json` or `CHANGELOG.md` for that bump.

## Approve the Release PR checks

The Release PR is authored by `github-actions[bot]`, because `release.yml` passes `github.token` to release-please. GitHub creates its checks but holds them until a user with write access approves.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` is documented for forks from first-time contributors and does not cover this gate.
- The approval does not stick. It is needed on every release, and again whenever release-please updates an open Release PR.
- **Merging without approving turns the runs red.** They finalise as `failure` with zero jobs and no logs. That means nobody approved them, not that anything broke.

This gate arrived with GitHub's [bot-created pull requests change](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/) and reached these repos in late August 2026. It applies to same-repo branches, not just forks, and has no repository-level opt-out. The only way to remove the step is to author the Release PR as a different identity, which needs a GitHub App or a PAT. Neither is set up here, and the click is cheaper.

## Branch protection

`main` should stay compatible with this flow:

- **Require a pull request before merging** (0 required approvals is fine for a solo maintainer).
- **Enforce for administrators** so direct pushes to `main` are blocked.
- **Squash-only merges** with the PR title as the commit subject (release-please reads that title).
- **Block force-pushes and deletions.**
- **Do not require status checks on the Release PR.** The Release PR's own checks are held for approval, so a required check there would sit unresolved until someone approves it. Code PRs still run Tests/CodeQL; review those before merging.

### Actions permission (required once)

Under **Settings → Actions → General → Workflow permissions**:

1. **Read and write permissions**
2. **Allow GitHub Actions to create and approve pull requests**

Without (2), release-please can update its branch but cannot open the Release PR.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads.
- **Version source of truth** is `.release-please-manifest.json`. Do not hand-edit version fields for routine releases.
- Behavior is configured in `release-please-config.json`.

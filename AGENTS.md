# Agent Workflow

## Releasing anything

Every release goes through the `release` skill: `.agents/skills/release/SKILL.md`.
Read it in full before native release builds, store submissions, CLI
publishes, or dispatching a release workflow. The former Expo/EAS app and
OTA scripts have been removed; mobile clients are native iOS and Android.

The rule the skill opens with is the one that is never skipped: **release from
a local `main` that is exactly `origin/main`, checked against a fetch made right
then, with a clean tree.** Not from a worktree. Not from a branch. Not from a
`main` that is ahead or behind. Perform these checks before every release.

For the owner's MacBook Happy Personal CLI session-recovery fixes, the owner has granted a revocable personal-fork release policy. Verify the personal remote is `git@github.com:lindong28/happy.git`, the reviewed commit is on its current `main`, and local tests and CI passed. Build that exact clean tree and install through the MacBook's managed Personal CLI entry. This grant covers only that host and component. It ends on owner revocation (remove this paragraph and its pointer from the release skill). Other release targets follow the rules below.

For other releases the only exception is one the user asks for by name in the current
conversation. A standing instruction from an earlier session is not that, and
neither is your own judgement that it is probably fine. When they do ask, the
skill says how: show what `main` commits the release will lack, get a yes,
and say it was off-main in the report.

Why: an OTA channel serves whatever was published last, not whatever is on
`main`. On 2026-09-20 a preview OTA from a stale worktree silently rolled four
shipped fixes off every preview phone for hours. Git looked fine the whole time.

## Real iPhone session checks

Before testing an installed iPhone app through the phone or iPhone Mirroring, read [iPhone session acceptance](packages/happy-ios/docs/DEVICE-ACCEPTANCE.md). It owns this project's session selection, input and interruption procedure; simulator captures alone do not establish live phone behavior.

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.

#!/usr/bin/env bash
# Applies the fork's patch branches to an upstream checkout and checks the result. When a
# cherry-pick conflicts, or the patched tree fails typecheck or tests, the Cursor CLI agent
# is asked to fix it. Needs CURSOR_API_KEY for that; without it, the first failure stops.
#
#   patch-reconcile.sh apply   cherry-pick every branch in PATCH_BRANCHES
#   patch-reconcile.sh check   typecheck and test, fixing failures up to two rounds
#
# Anything the agent changes is described in $RUNNER_TEMP/ai-notes.md, which later steps
# put into the release notes.
set -euo pipefail

notes="$RUNNER_TEMP/ai-notes.md"
fork_changes="$RUNNER_TEMP/FORK_CHANGES.md"

summary() { echo "$*" >> "$GITHUB_STEP_SUMMARY"; }

have_agent() { [ -n "${CURSOR_API_KEY:-}" ]; }

run_agent() {
  if ! command -v cursor-agent >/dev/null 2>&1; then
    curl -fsS https://cursor.com/install | bash >/dev/null
    export PATH="$HOME/.local/bin:$PATH"
  fi
  local prompt="$1"
  prompt+=$'\n\n# What the fork changes\n\n'
  prompt+="$(cat "$fork_changes" 2>/dev/null || echo "(FORK_CHANGES.md was not found.)")"
  # --force lets the agent run commands (typecheck, tests) without approval prompts.
  timeout 45m cursor-agent -p --force --output-format text "$prompt" | tail -n 60
}

unmerged() { git diff --name-only --diff-filter=U; }

cherry_pick_in_progress() { [ -e .git/CHERRY_PICK_HEAD ] || [ -d .git/sequencer ]; }

resolve_conflicts() {
  local branch="$1" steps=0
  while cherry_pick_in_progress; do
    steps=$((steps + 1))
    if [ "$steps" -gt 30 ]; then
      summary "Gave up reconciling \`$branch\`: the cherry-pick kept stopping."
      git cherry-pick --abort
      exit 1
    fi
    local files
    files=$(unmerged)
    if [ -z "$files" ]; then
      # A commit that became empty after resolution: upstream already has it.
      if [ -z "$(git diff --cached --name-only)" ]; then
        git cherry-pick --skip
      else
        GIT_EDITOR=true git cherry-pick --continue || true
      fi
      continue
    fi
    local commit
    commit=$(git rev-parse --short CHERRY_PICK_HEAD)
    if ! have_agent; then
      summary "The \`$branch\` patch conflicts with upstream v$VERSION in:"
      summary "$(sed 's/^/- /' <<<"$files")"
      summary "Rebase it, or add the \`CURSOR_API_KEY\` secret so the build can reconcile it."
      git cherry-pick --abort
      exit 1
    fi
    run_agent "$(cat <<EOF
You are resolving a git cherry-pick conflict in the T3 Code monorepo. The working tree is
upstream release v$VERSION with the fork's patch branch \`$branch\` being replayed onto it.
The commit being applied is:

$(git show --stat --format='%H%n%n%B' CHERRY_PICK_HEAD)

Conflicted files:
$files

Resolve every conflict in those files. Keep upstream's new code and reapply the patch's
behavior on top of it: if upstream renamed or replaced something the patch uses, move the
patch onto the new version instead of restoring the old one. Remove all conflict markers.
Do not commit, do not run any git command that changes history or the index, and do not
edit files that are not part of the conflict unless the patch cannot work without it.
EOF
)"
    if [ -n "$(git grep -lE '^(<<<<<<<|>>>>>>>)( |$)' -- $files || true)" ]; then
      summary "The agent left conflict markers in \`$branch\` ($commit). Rebase it by hand."
      git cherry-pick --abort
      exit 1
    fi
    # shellcheck disable=SC2086
    git add -- $files
    {
      echo "- Resolved conflicts applying \`$branch\` commit $commit ($(git log -1 --format=%s "$commit")) in:"
      sed 's/^/  - `/; s/$/`/' <<<"$files"
    } >> "$notes"
    GIT_EDITOR=true git cherry-pick --continue || true
  done
}

apply() {
  for branch in $PATCH_BRANCHES; do
    if ! git fetch -q --filter=blob:none origin "refs/heads/$branch:refs/remotes/origin/$branch"; then
      summary "Skipped \`$branch\`: not on the fork."
      continue
    fi
    local base
    base=$(git merge-base "origin/$branch" HEAD)
    if ! git cherry-pick --empty=drop "$base..origin/$branch"; then
      resolve_conflicts "$branch"
    fi
  done
  summary '```'
  summary "$(git log --oneline "upstream-v$VERSION..HEAD")"
  summary '```'
}

run_checks() {
  (
    set -e
    (cd apps/server && vp run typecheck)
    (cd apps/web && vp run typecheck)
    (cd apps/server && vp test run src/mcp/toolkits/preview/overflowCheck.test.ts src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts src/orchestration-v2/Adapters/CodexAdapterV2.test.ts src/orchestration-v2/Adapters/claudeSessionTransfer.test.ts src/orchestration-v2/ProviderTurnStartService.test.ts src/orchestration-v2/ThreadRecapService.test.ts src/orchestration-v2/ThreadTransferService.test.ts)
    (cd apps/web && vp test run src/components/ChatView.logic.test.ts src/components/BranchToolbar.logic.test.ts src/components/chatCopy.logic.test.ts src/components/chat/ContextWindowMeter.logic.test.ts src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx src/components/chat/useThreadRecap.test.ts src/environmentGrouping.test.ts)
    (cd packages/client-runtime && vp test run src/state/projectGrouping.test.ts src/state/threadWorkflows.test.ts)
    (cd native/hyprland-snap-shot && cargo test --quiet)
  ) > "$RUNNER_TEMP/checks.log" 2>&1
}

check() {
  local round
  for round in 1 2 3; do
    if run_checks; then
      tail -n 20 "$RUNNER_TEMP/checks.log"
      return 0
    fi
    cat "$RUNNER_TEMP/checks.log"
    if [ "$round" = 3 ] || ! have_agent; then
      summary "Typecheck or tests failed on the patched v$VERSION."
      exit 1
    fi
    local before
    before=$(git rev-parse HEAD)
    run_agent "$(cat <<EOF
The T3 Code monorepo here is upstream release v$VERSION with the fork's patch branches
($PATCH_BRANCHES) applied. The patched tree fails its typecheck or tests. The patches
applied without conflicts, so upstream most likely renamed, moved or removed something a
patch relies on. Fix the patch code so it works against this upstream version, keeping
the patch's behavior. Do not weaken, skip or delete tests, and do not change upstream code
beyond what the patch needs. Rerun the failing commands until they pass:

  (cd apps/server && vp run typecheck)
  (cd apps/web && vp run typecheck)
  (cd apps/server && vp test run src/mcp/toolkits/preview/overflowCheck.test.ts src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts src/orchestration-v2/Adapters/CodexAdapterV2.test.ts src/orchestration-v2/Adapters/claudeSessionTransfer.test.ts src/orchestration-v2/ProviderTurnStartService.test.ts src/orchestration-v2/ThreadRecapService.test.ts src/orchestration-v2/ThreadTransferService.test.ts)
  (cd apps/web && vp test run src/components/ChatView.logic.test.ts src/components/BranchToolbar.logic.test.ts src/components/chatCopy.logic.test.ts src/components/chat/ContextWindowMeter.logic.test.ts src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx src/components/chat/useThreadRecap.test.ts src/environmentGrouping.test.ts)
  (cd packages/client-runtime && vp test run src/state/projectGrouping.test.ts src/state/threadWorkflows.test.ts)
  (cd native/hyprland-snap-shot && cargo test --quiet)

Do not commit. The failing output:

$(tail -n 150 "$RUNNER_TEMP/checks.log")
EOF
)"
    if [ -z "$(git status --porcelain)" ]; then
      summary "The agent made no changes after round $round of failing checks."
      exit 1
    fi
    git add -A
    git commit -q -m "fix: reconcile the fork's patches with upstream v$VERSION (round $round)"
    {
      echo "- Fixed failing checks (round $round):"
      git diff --stat "$before" HEAD | sed 's/^/  /'
    } >> "$notes"
  done
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: $0 apply|check" >&2; exit 2 ;;
esac

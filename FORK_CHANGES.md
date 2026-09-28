# What this fork changes

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). This file lists everything the fork adds on top of upstream and where each change lives. Update it whenever a patch branch or fork workflow changes. The patched-release workflow also gives this file to the AI agent that reconciles patches with upstream, so each entry says what the change is for as well as what it does.

## How the changes ship

- `nowbar` (default branch) carries the Android Now Bar work and the fork's CI. It merges `upstream/main` by hand.
- Desktop and server changes live on patch branches based on `upstream/main`. The patched-release workflow cherry-picks them, in the order below, onto every upstream nightly and publishes the result here under the same version number.
  - The Linux AppImage and the Windows installer update themselves from this repository's releases.
  - Servers whose service sets `T3CODE_RELEASE_BASE_URL=https://github.com/Ta-noshii/t3code-nowbar/releases/download` install the patched runtime through the normal in-app Update.

## Patch branches (desktop and server)

### `patch/edit-fork`

Claude Code history tools that upstream lacks.

- **Fork a thread / edit a message in a new thread.** "Fork from here" on any message, and "Edit" on a user message, open a new thread containing the history up to that point. For Claude, the new thread gets a real copy of the Claude session (the SDK's `forkSession`, cut at the matching message), so the agent keeps its context. Providers without session forking get the earlier messages as an attached `earlier-conversation.md`. Server RPC `orchestration.forkThread`, capability `threadFork`.
- **Older Claude threads.** Threads recorded before turn boundaries were stored still fork correctly; the cut point is found from the message ids in the Claude transcript.
- **Copy a chat to another machine.** The environment chip in the composer is always shown, including on the local machine. On a started chat it opens a menu listing the machine the chat runs on, then one submenu per other connected environment with its projects. Picking a project asks for confirmation, then creates a copy of the chat on that machine.
  - Both machines on a patched build: the source exports the thread (`orchestration.exportThread`) and the target imports it (`orchestration.importThread`, capability `threadTransfer`). Claude sessions travel as a gzipped export of the session store, subagent transcripts included, and are written into the target's Claude home as a fork. The copy shows the full history and the agent remembers it.
  - Target without the import RPC, or a provider without session export: the copy starts with a first message that carries the conversation and asks the agent to summarise where things stand, so the agent picks the work up without the user resending anything.
  - The copy works in the target project's main folder, since the source's worktree exists only on the source machine.
- **Agents panel detail.** Each agent in the Agents panel opens a detail view with its status, model, start and finish times, token breakdown and tool-call count, followed by the task it was given, its result, and every step it took. Tool calls expand to show their output, and a running agent's steps refresh every few seconds. The steps come from the agent's own transcript: `orchestration.getAgentTranscript` (capability `agentTranscripts`) finds the Claude subagent a tool call spawned through the `agent-<id>.meta.json` the CLI writes beside its transcript, and reads it with the SDK's `getSubagentMessages`. Other providers and older servers show the result and recent activity from the activity stream.
- **Collapsed thinking shows its steps.** Upstream collapses a run of thinking and tool calls to one line ("Thinking", the current tool, or "Read 3 files"). The fork lists the group's last six steps under that line: each tool call with what it touched (file, command, query), each thought as "Thought for 4.2s" with its bold title or first words, and while the agent thinks, the newest three lines of its reasoning fading in at the bottom. Clicking any line opens the full view. `buildActivityTrail` in `MessagesTimeline.logic.ts`, `ActivityTrail` in `MessagesTimeline.tsx`.
- **Prompt suggestions.** After each Claude turn (except the first), an empty composer shows Claude Code's guess at your next prompt, and Tab fills it in. The Claude adapter turns on the SDK's `promptSuggestions` and forwards each one as a `turn.suggestion` runtime event, stored as a hidden `prompt.suggestion` activity on the turn it follows. Claude's own `promptSuggestionEnabled: false` setting still turns them off. Other providers have no equivalent.
- **Recap when you come back.** Returning to a finished Claude thread after 5+ minutes away shows a one-line "While you were away" recap above the composer, once per turn, dismissable. `orchestration.getThreadRecap` (capability `threadRecap`) runs Claude Code's `/recap` in a fork of the session with `persistSession: false`, so nothing is added to the conversation.
- **Messages that wait for the turn to end.** Shift+Enter while the agent works queues a message that waits until the turn finishes, instead of steering at the next tool call. The hourglass button on each queued message switches between the two. While the agent runs, Shift+Enter no longer inserts a newline.
- **Compact after this turn.** While the agent works, the context meter's compact button reads "Compact after this turn" and queues `/compact` as an after-turn message instead of being disabled. The queued row's cancel button takes it back.
- **Overflow check in the Browser panel.** `preview_overflow_check`, a tool on the t3-code MCP server next to the other `preview_*` tools, resizes the Browser panel tab through 375, 768 and 1440 px (or the widths given), runs the DOM overflow scanner in the page and returns a text report: spill, clip, page and ringclip findings with the deepest box that does not fit as the cause, plus truncate and scroll lines as information. Same report as Playwright's `browser_overflow_check`, so agents read one format in and out of T3. `restore=true` puts the viewport setting back. The scanner is inlined from `apps/server/src/mcp/toolkits/preview/overflowScanSource.ts`, regenerated from `~/pbf-e2e-harness/overflow.js` by `scripts/sync-overflow-scan-source.ts`.
- CI tests: `apps/server` `forkThread.test.ts`, `mcp/toolkits/preview/overflowCheck.test.ts`, `transferThread.test.ts`, `claudeHistoryWorker.test.ts`, `ClaudeAdapter.test.ts`; `apps/web` `ChatView.logic.test.ts`, `BranchToolbar.logic.test.ts`, `MessagesTimeline.logic.test.ts`, `composer-logic.test.ts`, `queuedMessageStore.test.ts`, `useThreadRecap.test.ts`; `ProviderRuntimeIngestion.activity.test.ts`.

### `fix/hyprland-snapshot-flight-sizing`

Upstream PR [pingdotgg/t3code#11591](https://github.com/pingdotgg/t3code/pull/11591), carried until it merges. With capture animations on, the SnapShots flight from the window to the draft drew an oversized, stretched rectangle on Hyprland, because Hyprland 0.56.2 updates a surface's size only when a buffer is attached. The fix reattaches the capture buffer on every visible flight frame, while full damage stays gated on a texture change. CI test: `native/hyprland-snap-shot` `cargo test`.

When the PR merges, delete the branch. The workflow skips branches that no longer exist, and commits upstream already has drop out as empty cherry-picks.

### `fix/preview-viewport-main-zoom`

Upstream PR [pingdotgg/t3code#14039](https://github.com/pingdotgg/t3code/pull/14039), carried until it merges. With the main window zoomed (View → Zoom In), the Browser panel's freeform and preset viewports rendered at the zoomed size (1280 measured as 1403), so every freeform `preview_resize` timed out and `preview_overflow_check` could not run. The fix sizes the webview by the main window's zoom factor so the page measures the requested CSS size.

When the PR merges, delete the branch, as with the SnapShots fix above.

## Android (on `nowbar`)

- **Samsung Now Bar agent monitoring.** The Android app shows agents in Samsung's Now Bar, with a distinct state per agent status, and keeps unread results. It handles attention, privacy and notification settings, keeps the bar fresh when React Native timers pause, and stops monitoring once every environment disconnects.
- Custom Now Bar cards delivered through private host push, expanded cards with live agent updates, layout and text fixes, and a Now Bar state lab.
- Signed fork updates: the app updates from this repository's releases instead of upstream's.
- Workflow `nowbar-release.yml` syncs upstream and builds the signed APK. It passes `-R "$GITHUB_REPOSITORY"` to `gh`, because the checkout has an `upstream` remote that `gh` would otherwise pick.

## Fork CI

- `patched-release.yml` runs every 4 hours and builds the newest upstream nightly that has no patched release yet. Stable versions build only when started by hand. For each version it:
  1. installs dependencies on the upstream tree,
  2. cherry-picks the patch branches, asking the Cursor CLI agent to resolve any conflict,
  3. typechecks the server and web apps and runs the tests above, asking the agent to fix failures (up to two rounds),
  4. builds the Linux AppImage and the server archive,
  5. applies the same patched tree on a Windows runner and builds the unsigned x64 NSIS installer, embedding the Linux server archive as the WSL runtime,
  6. publishes release `v<version>` and keeps the newest five. If the Windows build fails, the release ships without it and the notes say so.

  When the agent changed anything, the release notes say so and the release carries `ai-reconciliation.patch`. Fold that diff into the patch branch so later builds apply cleanly. The agent needs the repository secret `CURSOR_API_KEY`; without it, a conflict or failed check stops the build as before.
- The release tags the `nowbar` commit the workflow ran from, not the patched tree. The workflow token may not push a commit that edits upstream's `.github/workflows` files.

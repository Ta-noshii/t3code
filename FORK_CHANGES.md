# What this fork changes

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). This file lists everything the fork adds on top of upstream and where each change lives. Update it whenever a patch branch or fork workflow changes. The patched-release workflow also gives this file to the AI agent that reconciles patches with upstream, so each entry says what the change is for as well as what it does.

## How the changes ship

- `nowbar` (default branch) carries the Android Now Bar work and the fork's CI. It merges `upstream/main` by hand.
- Desktop and server changes live on patch branches based on `upstream/main`. The patched-release workflow cherry-picks them, in the order below, onto every upstream nightly and publishes the result here under the same version number.
  - The Linux AppImage and the Windows installer update themselves from this repository's releases.
  - Servers whose service sets `T3CODE_RELEASE_BASE_URL=https://github.com/Ta-noshii/t3code-nowbar/releases/download` install the patched runtime through the normal in-app Update.

## Patch branches (desktop and server)

### `patch/edit-fork-v2`

Features upstream lacks, rebuilt on upstream's v2 orchestrator (upstream PR #2829, 2026-10-02, which deleted the v1 orchestration the old `patch/edit-fork` and `patch/subagents` branches were written against). Both old branches are retired. Upstream's own `delegate_task` orchestrator tools replace `patch/subagents`: they start a subagent on any provider and model and are on by default. Upstream's "Fork from this response" and its follow-up queue replace the old fork-from-a-reply and the hourglass "wait for the turn" button.

- **Edit a message in a new thread.** "Edit in new thread" (pen icon) on a user message opens a new thread with the history up to just before it and puts the message text and attachments in the composer, unsent; the original thread is untouched. The new thread forks the run that answered the previous message through upstream's `thread.fork`. With no earlier run (first message, or history imported from v1), it starts as a draft in the same workspace with the earlier messages as `earlier-conversation.md`. Upstream's "Edit from here" (rewind) stays beside it. Planning logic: `packages/client-runtime/src/state/threadWorkflows.ts`.
- **Fork fallback.** When a provider cannot copy its session for a fork (for example a missing Claude session file), the fork's first turn retries, then opens a fresh session and receives the inherited conversation as context instead of failing (`ProviderTurnStartService.ts`).
- **Copy a chat to another machine.** The composer's environment chip is always shown and opens a menu of the other connected environments and their projects; the thread details panel's environment row opens the same menu. Picking a project asks for confirmation, then copies the chat there. Both sides patched: `orchestration.exportThread` / `orchestration.importThread` (capability `threadTransfer`, `ThreadTransferService.ts`); Claude sessions travel as a gzipped session export (subagent transcripts included, capped at 48 MB) and resume on the target. Otherwise the copy starts with a turn that hands over the conversation and asks for a summary. The copy works in the target project's main folder.
- **Compact after this turn.** While the agent works, the context meter's button reads "Compact after this turn" and queues `/compact` as its own turn; the queued row's remove button cancels it. The server refuses to steer `/compact` into a running turn, so a typed `/compact` during a turn always queues.
- **Auto-compact window in the context meter.** For a thread on a Claude instance, the Context Window popover has an "Auto-compact at" select (Claude default, 100k–1M, capped at the model's window) that edits that instance's `autoCompactWindow` setting on the thread's environment, the same setting as the Providers page. It takes effect when Claude next opens a session for the thread.
- **Collapsed work groups list their steps.** Under a collapsed group's header, the last steps show as one-line links (tool calls with what they touched, thoughts with their duration and title, and the newest reasoning lines while thinking).
- **Prompt suggestions.** After a Claude turn (not the first), an empty composer shows Claude Code's guess at the next prompt; Tab fills it in. Claude's `promptSuggestionEnabled: false` turns it off.
- **Recap when you come back.** Returning to a finished Claude thread after 5+ minutes away (window focused) shows a one-line "While you were away" recap once per run, dismissable. The server runs Claude Code's `/recap` in a fork of the session that is never written to disk.
- **Overflow check in the Browser panel.** `preview_overflow_check` on the `t3-code` MCP server resizes the Browser panel tab through 375, 768 and 1440 px (or the widths given), runs the DOM overflow scanner and returns the same text report as Playwright's `browser_overflow_check`. `urls=[...]` scans several pages in one call; a page that answers HTTP 400+ or fails to load reports "did not load". `restore=true` puts the viewport back, also when a scan fails. The scanner is inlined from `apps/server/src/mcp/toolkits/preview/overflowScanSource.ts`, regenerated from `~/pbf-e2e-harness/overflow.js` by `scripts/sync-overflow-scan-source.ts`.
- **Short model list in `orchestrator_capabilities`.** The server setting `orchestratorModels` (provider instance + model slug pairs, edited in `settings.json`) limits the tool's answer to those models plus the calling thread's own model; providers that cannot run child tasks are left out by default. `hiddenModelCount` says how many were dropped and `all: true` returns the whole catalog. `delegate_task` still accepts any catalog model. Upstream's answer lists every model of every provider with full option descriptors, tens of thousands of characters with Cursor and OpenCode configured.
- **Codex MCP tool timeout.** `CodexAdapterV2` gives the `t3-code` server `tool_timeout_sec` 3900 (65 minutes, matching Claude's), since orchestrator waits run up to an hour and Codex's default is 60 seconds.
- **Tool results as summaries and images.** Expanding a T3 tool row shows a digest of the result instead of its fields: status with an icon, the task, page or thread it acted on (marked by kind), the model with its provider logo and display name, an "Open task thread" button, the summary as markdown, lists as rows or "No threads", errors as a failure line. The call shows the prompt (collapsed when long), the target model and the other arguments without IDs. IDs and leftovers sit in a collapsed Details section with the raw JSON; other dynamic tools get the same generic digest, and mobile text uses it too (`packages/client-runtime/src/work-log/toolDigest.ts`, `toolValue.ts`, `ToolOutputView.tsx`). The detail read replaces inline images with their metadata and keeps base64 only within a 192 KB budget (`packages/shared/src/toolMedia.ts`, `WireProjection.ts`). Before this, an image result over 256 KB was stringified, cut, and printed as raw base64.
- **Folders without a git remote group by path.** In the repository grouping modes, a project with no repository identity (such as `~/Work`) groups with projects at the same path in other environments instead of staying separate per environment (`projectGrouping.ts`).
- Not carried over: the Agents panel detail (upstream deleted the panel; subagent steps and results now show in the subagent's own thread), and the older-Claude-thread fork fix (threads imported from v1 keep no Claude session to cut).

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
  5. publishes release `v<version>` with the Linux assets and keeps the newest five,
  6. then applies the same patched tree on a Windows runner, builds the unsigned x64 NSIS installer (embedding the Linux server archive as the WSL runtime) and adds it to that release about 12 minutes later. If the Windows build fails, the notes say so, and the Windows app sees no update until a later release has one.

  When the agent changed anything, the release notes say so and the release carries `ai-reconciliation.patch`. Fold that diff into the patch branch so later builds apply cleanly. The agent needs the repository secret `CURSOR_API_KEY`; without it, a conflict or failed check stops the build as before.
- The release tags the `nowbar` commit the workflow ran from, not the patched tree. The workflow token may not push a commit that edits upstream's `.github/workflows` files.

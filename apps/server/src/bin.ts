/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads, as does `t3 secret prompt`,
 * which must report quickly when it cannot show a card, and the long-running
 * `t3 bar-bridge` for the Omarchy bar, which needs none of the CLI. Everything
 * else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "secret") {
    const { runSecretCliFastPath } = await import("./secrets/secretPromptCli.ts");
    await runSecretCliFastPath(process.argv.slice(3));
  } else if (command === "bar-bridge") {
    const { runBarBridge } = await import("./barBridge/bridge.ts");
    await runBarBridge();
  } else {
    // A server started from an agent shell must not pass that shell's thread
    // credential on to its own agents.
    delete process.env.T3CODE_THREAD_ID;
    delete process.env.T3CODE_AGENT_SHELL_URL;
    delete process.env.T3CODE_AGENT_SHELL_AUTHORIZATION;
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}

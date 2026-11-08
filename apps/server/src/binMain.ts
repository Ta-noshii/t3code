import { enableCliCompileCache } from "./cliCompileCache.ts";

// Packaged builds load this graph with require(esm): top-level await anywhere in it breaks them.
// ACP agents spawn `acp-mcp-bridge` per session and `acp-mcp-call` per tool call, and
// `t3 secret prompt` must report quickly when it cannot show a card, so those fast paths
// dispatch before the full CLI module graph (seconds of evaluation) loads. So does the
// long-running `t3 bar-bridge` for the Omarchy bar, which needs none of the CLI.
export async function runCliCommand() {
  const command = process.argv[2];
  // Install the socket guard before importing code that can open outbound connections.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__speech-worker") {
    const mode = process.argv[3];
    if (mode !== "discover" && mode !== "model") throw new Error("Unknown speech worker mode.");
    const { runNativeSpeechWorker } = await import("./speech/native.ts");
    await runNativeSpeechWorker(mode, process.argv[4]);
  } else if (command === "secret") {
    const { runSecretCliFastPath } = await import("./secrets/secretPromptCli.ts");
    await runSecretCliFastPath(process.argv.slice(3));
  } else if (command === "bar-bridge") {
    const { runBarBridge } = await import("./barBridge/bridge.ts");
    await runBarBridge();
  } else {
    enableCliCompileCache();
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    // A server started from an agent shell must not pass that shell's thread
    // credential on to its own agents.
    delete process.env.T3CODE_THREAD_ID;
    delete process.env.T3CODE_AGENT_SHELL_URL;
    delete process.env.T3CODE_AGENT_SHELL_AUTHORIZATION;
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}

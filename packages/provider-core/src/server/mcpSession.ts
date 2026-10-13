import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * The thread id, server URL and shell-only credential that let a process in
   * the agent's shell ask the user through the thread (`t3 secret prompt`).
   * Adapters spread it into the provider subprocess environment with
   * `withAgentShellEnvironment`; the credential does not open `/mcp`.
   */
  readonly agentShellEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/** Names in `agentShellEnvironment`; the server issues all three together. */
export const AGENT_SHELL_ENVIRONMENT_NAMES = [
  "T3CODE_THREAD_ID",
  "T3CODE_AGENT_SHELL_URL",
  "T3CODE_AGENT_SHELL_AUTHORIZATION",
] as const;

/**
 * Provider env with the agent shell variables and the device variables
 * applied over `base`. Use it wherever an adapter spawns the process whose
 * shell commands the agent runs.
 */
export function withAgentShellEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | Pick<McpProviderSessionConfig, "agentDeviceEnvironment" | "agentShellEnvironment">
    | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...withAgentDeviceEnvironment(base, config) };
  // Variables inherited from whatever launched the server belong to another
  // thread, possibly on another server; never pass them on.
  for (const name of AGENT_SHELL_ENVIRONMENT_NAMES) delete environment[name];
  return { ...environment, ...config?.agentShellEnvironment };
}

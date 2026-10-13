import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { runSecretCliFastPath } from "../secrets/secretPromptCli.ts";

/**
 * `t3 secret prompt` - ask the user for a password or secret from an agent
 * shell, through a card in the thread that owns the shell.
 *
 * Real invocations dispatch through the bin.ts fast path before the CLI graph
 * loads; this definition keeps the command in help.
 */
const promptCommand = Command.make("prompt", {
  title: Flag.String("title").pipe(Flag.withDescription("What the card asks for.")),
  description: Flag.String("description").pipe(
    Flag.withDescription("More detail. For --kind sudo, the command that needs root."),
    Flag.optional,
  ),
  kind: Flag.Literals("kind", ["sudo", "secret"]).pipe(
    Flag.withDescription("sudo for a root password, secret for any other credential."),
    Flag.withDefault("secret" as const),
  ),
  multiline: Flag.Boolean("multiline").pipe(
    Flag.withDescription("Use a multi-line field, for keys and certificates."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Ask the user privately and print the value. Exit 0 saved, 1 declined or timed out, 3 unavailable.",
  ),
  Command.withHandler(({ title, description, kind, multiline }) =>
    Effect.promise(() =>
      runSecretCliFastPath([
        "prompt",
        "--title",
        title,
        ...Option.match(description, {
          onNone: () => [],
          onSome: (text) => ["--description", text],
        }),
        "--kind",
        kind,
        ...(multiline ? ["--multiline"] : []),
      ]),
    ),
  ),
);

export const secretCommand = Command.make("secret").pipe(
  Command.withDescription("Ask the user for secrets from an agent shell."),
  Command.withSubcommands([promptCommand]),
);

import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { parseTrailingT3Blocks } from "@t3tools/shared/suggestedReplies";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * An agent marks its response as waiting on the user by ending the message
 * with a `t3-needs-reply` block. This records the mark on the thread for the
 * message's run, the same mark the user's next message clears.
 */
export class NeedsReplyReactor extends Context.Service<
  NeedsReplyReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/NeedsReplyReactor") {}

export const needsReplyRequestFor = (event: OrchestrationV2DomainEvent) => {
  if (event.type !== "turn-item.updated") return null;
  const item = event.payload;
  if (item.type !== "assistant_message" || item.streaming || item.runId === null) return null;
  const { needsReply } = parseTrailingT3Blocks(item.text);
  return needsReply === null ? null : { itemId: item.id, runId: item.runId, note: needsReply.note };
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;

  const handle: NeedsReplyReactor["Service"]["handle"] = (event) => {
    const request = needsReplyRequestFor(event);
    if (request === null) return Effect.void;
    return engine
      .dispatch({
        type: "thread.reply.request",
        commandId: CommandId.make(`server:needs-reply:${request.itemId}`),
        threadId: event.threadId,
        request: { runId: request.runId, note: request.note },
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a needs-reply mark failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      );
  };

  const start: NeedsReplyReactor["Service"]["start"] = Effect.fn("NeedsReplyReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("needs-reply event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { start, handle } satisfies NeedsReplyReactor["Service"];
});

export const layer = Layer.effect(NeedsReplyReactor, make);

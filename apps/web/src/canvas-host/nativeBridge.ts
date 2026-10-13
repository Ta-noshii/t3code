import {
  CanvasHostNativeMessage,
  type CanvasDocument,
  type CanvasHostPageMessage,
  type CanvasSaveInput,
  type CanvasSaveResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const REQUEST_TIMEOUT_MS = 30_000;

const decodeNativeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(CanvasHostNativeMessage),
);

/** A message from the native side, or null for anything else posted to the page. */
export function readNativeMessage(data: unknown): CanvasHostNativeMessage | null {
  return typeof data === "string" ? Option.getOrNull(decodeNativeMessage(data)) : null;
}

type Answer = Extract<CanvasHostNativeMessage, { type: "saved" | "document" }>;

/**
 * Requests to the native side, which runs the canvas RPCs for the page.
 * Each request resolves with native's answer, or null when native answers
 * with a failure or not at all within the timeout, so a sync queue waiting
 * on it never stalls.
 */
export class NativeBridge {
  private nextId = 0;
  private readonly waiting = new Map<number, (answer: Answer | null) => void>();

  constructor(
    private readonly send: (message: CanvasHostPageMessage) => void,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async save(input: Omit<CanvasSaveInput, "path">): Promise<CanvasSaveResult | null> {
    const answer = await this.request((requestId) => ({ type: "save", requestId, input }));
    return answer?.type === "saved" ? answer.result : null;
  }

  async read(knownFileIds: ReadonlyArray<string>): Promise<CanvasDocument | null> {
    const answer = await this.request((requestId) => ({
      type: "read",
      requestId,
      knownFileIds: [...knownFileIds],
    }));
    return answer?.type === "document" ? answer.document : null;
  }

  /** Settles the request a message answers; false when it answers none. */
  answer(message: CanvasHostNativeMessage): boolean {
    if (message.type !== "saved" && message.type !== "document") return false;
    const resolve = this.waiting.get(message.requestId);
    if (!resolve) return false;
    this.waiting.delete(message.requestId);
    resolve(message);
    return true;
  }

  private request(build: (requestId: number) => CanvasHostPageMessage): Promise<Answer | null> {
    const requestId = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(null);
      }, this.timeoutMs);
      this.waiting.set(requestId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.send(build(requestId));
    });
  }
}

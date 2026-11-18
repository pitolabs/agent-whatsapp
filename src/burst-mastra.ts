// Burst batching for Mastra channels (Chat SDK underneath): a ChannelHandler that gives one agent turn per burst of
// messages from one sender in a thread. `accept` runs synchronously when each message arrives (admission, and anything
// whose order must be the arrival order); accepted messages are buffered per thread (see ./burst.ts for the timing);
// the batch's `turn` runs once, one at a time per thread, and its `dispatch()` merges every message's text and
// attachments into the last one and runs the agent through that message's `defaultHandler`.
//
// Use it with Mastra's default `concurrency: { strategy: "concurrent" }`: the Chat SDK then calls the handler for every
// message as it arrives. Its own `debounce`/`burst` strategies wait a fixed window from the first message and call the
// handler late, with the earlier messages only in `ctx.skipped`.
import type { ChannelHandler, ChannelHandlerContext } from "@mastra/core/channels";
import { type Message, parseMarkdown, type Thread } from "chat";
import { type BurstTiming, createBurstQueue, type TurnQueue } from "./burst.ts";

export interface BurstItem<A> {
	thread: Thread;
	message: Message;
	/** Mastra binds each call's defaultHandler to that call's `ctx.requestContext`: keep the three together. */
	defaultHandler: (thread: Thread, message: Message) => Promise<void>;
	ctx: ChannelHandlerContext;
	/** What `accept` returned for this message. */
	accepted: A;
}

export interface BurstBatch<A> {
	/** The thread key (`thread.id` unless `key` says otherwise). */
	key: string;
	/** In arrival order, never empty, all from one sender. */
	items: BurstItem<A>[];
	/** The last item: its message receives the merged text and its call runs the agent. */
	last: BurstItem<A>;
	/** Merges the batch into `last.message` (mergeInto) and calls `last.defaultHandler`. Call it at most once. */
	dispatch(): Promise<void>;
}

export interface BurstHandlerOptions<A> {
	/** Called on arrival, synchronously. `undefined` ignores the message (the handler resolves at once). */
	accept: (thread: Thread, message: Message, ctx: ChannelHandlerContext) => A | undefined;
	/** Who sent it: a message from someone else closes the thread's open batch. */
	sender: (accepted: A) => string;
	/** Runs the batch. Omitted: `(batch) => batch.dispatch()`. Prepare the messages (and the request context) before `dispatch()`. */
	turn?: (batch: BurstBatch<A>) => Promise<void>;
	/** Omitted: DEFAULT_TIMING (2 s quiet, 8 s at most). `false`: every message is its own turn. */
	timing?: BurstTiming | false;
	turns?: Pick<TurnQueue, "run">;
	/** Omitted: `thread.id`. */
	key?: (thread: Thread) => string;
}

/**
 * Puts the texts of `messages` (non-empty ones, trimmed, blank-line separated) and all their attachments, in order,
 * into `target`, with `formatted` re-parsed (Mastra reads `formatted` before `text`). One message: left unchanged.
 */
export function mergeInto(target: Message, messages: readonly Message[]): void {
	if (messages.length < 2) return;
	const text = messages
		.map((m) => m.text.trim())
		.filter(Boolean)
		.join("\n\n");
	target.text = text;
	target.formatted = parseMarkdown(text);
	target.attachments = messages.flatMap((m) => m.attachments);
}

export function burstHandler<A>(options: BurstHandlerOptions<A>): ChannelHandler {
	const turn = options.turn ?? ((b: BurstBatch<A>) => b.dispatch());
	const keyOf = options.key ?? ((t: Thread) => t.id);
	const queue = createBurstQueue<BurstItem<A>>({
		group: (it) => options.sender(it.accepted),
		timing: options.timing,
		turns: options.turns,
		run: (key, items) => {
			const last = items[items.length - 1] as BurstItem<A>;
			return turn({
				key,
				items,
				last,
				dispatch: () => {
					mergeInto(
						last.message,
						items.map((it) => it.message),
					);
					return last.defaultHandler(last.thread, last.message);
				},
			});
		},
	});
	return (thread, message, defaultHandler, ctx) => {
		const accepted = options.accept(thread, message, ctx);
		if (accepted === undefined) return Promise.resolve();
		return queue.push(keyOf(thread), { thread, message, defaultHandler, ctx, accepted });
	};
}

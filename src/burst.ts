// One bot turn per burst of chat messages. People write in pieces ("oi", "tenho uma dúvida", "sobre a nota"); a bot
// that starts a run per piece answers each one. A burst queue holds a conversation's items while they keep coming and
// hands them to one `run` call: after `quietMs` without a new item, `maxWaitMs` after the first item at the latest,
// or at once when an item from another group (another sender) arrives, so one person's burst never absorbs someone
// else's message. Batches of one conversation run one at a time, in the order they were closed, which is the order
// their items arrived: closing on a group change is synchronous, and a timer only ever belongs to the newest open
// batch.
//
// Unlike a fixed window from the first message (Chat SDK's `debounce`/`burst`), the quiet time restarts with every
// item, so a message 3 s into a steady burst still joins it; and every item is kept, none is skipped. State lives in
// memory: a restart loses the open batches (at most `maxWaitMs` of items each).

export interface BurstTiming {
	/** Quiet time after the last item before the batch runs. */
	quietMs: number;
	/** Longest a batch waits after its first item. */
	maxWaitMs: number;
}

/** 2 s of quiet, 8 s at most: long enough for "oi" + the question, short enough not to feel slow. */
export const DEFAULT_TIMING: BurstTiming = { quietMs: 2000, maxWaitMs: 8000 };

/**
 * One turn at a time per key. `run` chains `turn` after the key's previous turn (whether that one resolved or
 * rejected) and returns its result; idle keys hold nothing.
 */
export class TurnQueue {
	private tails = new Map<string, Promise<void>>();

	run(key: string, turn: () => Promise<void>): Promise<void> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		const next = prev.then(turn, turn);
		const tail = next.catch(() => {});
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}
}

export interface BurstQueueOptions<T> {
	/** Runs one closed batch, items in arrival order (never empty). */
	run: (key: string, items: T[]) => Promise<void>;
	/** Items of different groups (senders) never share a batch: a new group closes the open batch. Omitted: one group. */
	group?: (item: T) => string;
	/** Omitted: DEFAULT_TIMING. `false`: no buffering, every item is its own batch (still one at a time per key). */
	timing?: BurstTiming | false;
	/** Where batches wait for the key's previous batch; share one to serialize with other work on the same keys. */
	turns?: Pick<TurnQueue, "run">;
}

export interface BurstQueue<T> {
	/**
	 * Adds `item` to `key`'s open batch (or opens one). Settles when that batch's `run` does: every item of a batch gets
	 * the same result, so a failed run rejects each of its pushes.
	 */
	push(key: string, item: T): Promise<void>;
}

interface Batch<T> {
	group: string;
	items: T[];
	/** Date.now() at the first item. */
	first: number;
	timer?: ReturnType<typeof setTimeout>;
	done: ReturnType<typeof Promise.withResolvers<void>>;
}

export function createBurstQueue<T>(options: BurstQueueOptions<T>): BurstQueue<T> {
	const turns = options.turns ?? new TurnQueue();
	const timing = options.timing === undefined ? DEFAULT_TIMING : options.timing;
	const groupOf = options.group ?? (() => "");
	const open = new Map<string, Batch<T>>();

	// turns.run is called synchronously, so the run order is the close order.
	const close = (key: string): void => {
		const b = open.get(key);
		if (!b) return;
		clearTimeout(b.timer);
		open.delete(key);
		turns.run(key, () => options.run(key, b.items)).then(b.done.resolve, b.done.reject);
	};

	return {
		push(key, item) {
			const group = groupOf(item);
			let b = open.get(key);
			if (b && b.group !== group) {
				close(key);
				b = undefined;
			}
			if (!b) {
				b = { group, items: [], first: Date.now(), done: Promise.withResolvers<void>() };
				open.set(key, b);
			}
			b.items.push(item);
			if (timing === false) close(key);
			else {
				clearTimeout(b.timer);
				const wait = Math.min(timing.quietMs, b.first + timing.maxWaitMs - Date.now());
				b.timer = setTimeout(() => close(key), Math.max(0, wait));
			}
			return b.done.promise;
		},
	};
}

// The burst queue's contract on fake time: when a batch closes, what it holds, and in which order batches run.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createBurstQueue } from "../src/burst.ts";

interface Msg {
	from: string;
	text: string;
}

/** Lets closed batches' async runs progress (no timers involved). */
const flush = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};

function recorder(hold?: (items: Msg[]) => Promise<void>) {
	const runs: string[][] = [];
	const q = createBurstQueue<Msg>({
		group: (m) => m.from,
		run: async (_key, items) => {
			runs.push(items.map((m) => `${m.from}:${m.text}`));
			await hold?.(items);
		},
	});
	return { runs, push: (from: string, text: string, key = "c") => q.push(key, { from, text }) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("createBurstQueue", () => {
	test("items within the quiet time run as one batch, once the quiet time has passed since the last", async () => {
		const { runs, push } = recorder();
		const sent = [push("b", "a")];
		jest.advanceTimersByTime(1000);
		sent.push(push("b", "b"));
		jest.advanceTimersByTime(1000);
		sent.push(push("b", "c"));
		jest.advanceTimersByTime(1999);
		await flush();
		expect(runs).toEqual([]);
		jest.advanceTimersByTime(1);
		await Promise.all(sent);
		expect(runs).toEqual([["b:a", "b:b", "b:c"]]);
	});

	test("a batch closes at most maxWaitMs after its first item; later items start the next one", async () => {
		const { runs, push } = recorder();
		const sent: Promise<void>[] = [];
		for (let i = 1; i <= 6; i++) {
			if (i > 1) jest.advanceTimersByTime(1500);
			sent.push(push("b", `m${i}`)); // m1 at 0 ms ... m6 at 7500 ms
		}
		jest.advanceTimersByTime(500); // 8000 ms: 500 ms of quiet only, but 8 s since m1
		await sent[0];
		expect(runs).toEqual([["b:m1", "b:m2", "b:m3", "b:m4", "b:m5", "b:m6"]]);
		jest.advanceTimersByTime(1000);
		sent.push(push("b", "m7")); // 9000 ms
		jest.advanceTimersByTime(2000);
		await sent[6];
		expect(runs[1]).toEqual(["b:m7"]);
	});

	test("an item from another group closes the open batch at once; batches run in arrival order", async () => {
		const { runs, push } = recorder();
		const sent = [push("ana", "a")];
		jest.advanceTimersByTime(500);
		sent.push(push("caio", "b"));
		jest.advanceTimersByTime(500);
		sent.push(push("ana", "c"));
		jest.advanceTimersByTime(2000);
		await Promise.all(sent);
		expect(runs).toEqual([["ana:a"], ["caio:b"], ["ana:c"]]);
	});

	test("conversations are independent: one's burst does not close or delay another's", async () => {
		const { runs, push } = recorder();
		const a = push("b", "x", "c1");
		jest.advanceTimersByTime(1500);
		const b = push("k", "y", "c2");
		jest.advanceTimersByTime(500);
		await a;
		expect(runs).toEqual([["b:x"]]);
		jest.advanceTimersByTime(1500);
		await b;
		expect(runs).toEqual([["b:x"], ["k:y"]]);
	});

	test("a batch closed while the previous one runs waits for it, then runs on its own", async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const { runs, push } = recorder((items) => (items[0]?.text === "a" ? held : Promise.resolve()));
		const first = push("b", "a");
		jest.advanceTimersByTime(2000);
		await flush();
		jest.advanceTimersByTime(2000);
		const second = push("b", "b");
		jest.advanceTimersByTime(2000);
		await flush();
		expect(runs).toEqual([["b:a"]]);
		release();
		await Promise.all([first, second]);
		expect(runs).toEqual([["b:a"], ["b:b"]]);
	});

	test("every push of a failed batch rejects, and the conversation keeps running later batches", async () => {
		let fail = true;
		const q = createBurstQueue<string>({
			run: async () => {
				if (fail) throw new Error("model down");
			},
		});
		const a = q.push("c", "a");
		const b = q.push("c", "b");
		jest.advanceTimersByTime(2000);
		await expect(a).rejects.toThrow("model down");
		await expect(b).rejects.toThrow("model down");
		fail = false;
		const c = q.push("c", "c");
		jest.advanceTimersByTime(2000);
		await expect(c).resolves.toBeUndefined();
	});

	test("timing false: every item is its own batch, run without waiting for a timer", async () => {
		const runs: string[][] = [];
		const q = createBurstQueue<string>({ timing: false, run: async (_k, items) => void runs.push(items) });
		await Promise.all([q.push("c", "a"), q.push("c", "b")]);
		expect(runs).toEqual([["a"], ["b"]]);
	});
});

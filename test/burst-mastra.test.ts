// The Mastra adapter: a burst reaches the agent once, as the last message's call, with every message's text and
// attachments; the message Mastra reads (`formatted` first) says the same as `text`.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { type Attachment, type Message, parseMarkdown, type Thread, toPlainText } from "chat";
import { burstHandler } from "../src/burst-mastra.ts";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const msg = (id: string, from: string, text: string, attachments: Attachment[] = []) =>
	({ id, text, formatted: parseMarkdown(text), attachments, author: { userId: from } }) as unknown as Message;
const image = (name: string): Attachment => ({ type: "image", mimeType: "image/jpeg", name });

test("one burst runs the agent once, through the last message's defaultHandler, with all texts and attachments", async () => {
	const handler = burstHandler<string>({
		accept: (_t, m) => (m.text === "ignore me" ? undefined : m.author.userId),
		sender: (from) => from,
	});
	const calls: { via: string; text: string; plain: string; attachments: string[] }[] = [];
	const deliver = (m: Message) =>
		handler(
			{ id: "t1" } as Thread,
			m,
			async (_t, got) =>
				void calls.push({ via: m.id, text: got.text, plain: toPlainText(got.formatted), attachments: got.attachments.map((a) => a.name ?? "") }),
			{} as never,
		);
	const sent = [deliver(msg("m1", "u", "oi", [image("a.jpg")]))];
	jest.advanceTimersByTime(500);
	sent.push(deliver(msg("m2", "u", "ignore me")));
	sent.push(deliver(msg("m3", "u", "  ")));
	jest.advanceTimersByTime(500);
	sent.push(deliver(msg("m4", "u", "**tenho** uma dúvida", [image("b.jpg")])));
	jest.advanceTimersByTime(2000);
	await Promise.all(sent);
	expect(calls).toEqual([{ via: "m4", text: "oi\n\n**tenho** uma dúvida", plain: "oi\n\ntenho uma dúvida", attachments: ["a.jpg", "b.jpg"] }]);
});

test("turn prepares the batch before dispatch; a single message reaches the agent unchanged", async () => {
	const seen: string[] = [];
	const handler = burstHandler<string>({
		accept: (_t, m) => m.author.userId,
		sender: (from) => from,
		turn: async (b) => {
			seen.push(`${b.key}:${b.items.length}:${b.last.accepted}`);
			await b.dispatch();
		},
	});
	const m = msg("m1", "u", "só uma");
	let got: Message | undefined;
	const p = handler(
		{ id: "t9" } as Thread,
		m,
		async (_t, x) => {
			got = x;
		},
		{} as never,
	);
	jest.advanceTimersByTime(2000);
	await p;
	expect(seen).toEqual(["t9:1:u"]);
	expect(got).toBe(m);
	expect(got?.text).toBe("só uma");
});

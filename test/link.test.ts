// The pairing pages know a device's link state only from the Baileys adapter's log lines. BaileysAdapter.initialize()
// replaces the adapter's own logger with chat.getLogger("baileys"), so the watcher has to be the Chat SDK logger.
// This drives the real Chat + BaileysAdapter through initialize(), then has the adapter log through the logger it
// ended up with, exactly as its connection.update handler does.
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Logger } from "chat";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { asChatAdapter, type Closed, heartbeatState, Link, type LinkState } from "../src/link.ts";

const noAuth = { state: { creds: {}, keys: {} }, saveCreds: async () => {} } as unknown as Parameters<typeof createBaileysAdapter>[0]["auth"];
// The adapter keeps its logger in a private field; the test reads it the way the adapter's own code uses it.
const adapterLogger = (a: object) => Reflect.get(a, "_logger") as { info: (m: string) => void; warn: (m: string) => void };

async function initialized(link: Link, chatLogger?: Logger) {
	const adapter = createBaileysAdapter({ auth: noAuth, logger: link.watchingLogger("adapter") });
	const chat = new Chat({ adapters: { whatsapp: asChatAdapter(adapter) }, state: createMemoryState(), userName: "Clerk", logger: chatLogger ?? "silent" });
	await chat.initialize();
	return adapterLogger(adapter);
}

describe("WhatsApp link state", () => {
	test("follows the adapter's connect and logout lines when the watcher is the Chat SDK logger", async () => {
		const link = new Link();
		link.set("waiting-for-scan", "qr-data");
		const log = await initialized(link, link.watchingLogger());
		log.info("Connected to WhatsApp");
		expect(link.state.status).toBe("connected");
		expect(link.state.qr).toBeUndefined();
		log.warn("Logged out — not reconnecting.");
		expect(link.state.status).toBe("logged-out");
	});

	test("goes deaf when the watcher is only the adapter's own logger (the bug this guards)", async () => {
		const link = new Link();
		link.set("waiting-for-scan", "qr-data");
		const log = await initialized(link);
		log.info("Connected to WhatsApp");
		expect(link.state.status).toBe("waiting-for-scan");
	});

	test("two linked devices keep separate states: one connecting does not mark the other paired", async () => {
		const sales = new Link();
		const support = new Link();
		support.set("waiting-for-scan", "support-qr");
		const log = await initialized(sales, sales.watchingLogger());
		log.info("Connected to WhatsApp");
		expect(sales.state.status).toBe("connected");
		expect(support.state).toMatchObject({ status: "waiting-for-scan", qr: "support-qr" });
	});
});

describe("WhatsApp link heartbeat (log monitoring reads it)", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());
	const states: [LinkState["status"], string][] = [
		["starting", "starting"],
		["waiting-for-scan", "waiting_for_scan"],
		["connected", "connected"],
		["logged-out", "logged_out"],
	];

	test.each(states)("%s prints `[sales-chat:link] status: %s`, first after the first delay then every interval, no phone or JID", (status, word) => {
		const lines: string[] = [];
		const info = spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
		const link = new Link({ firstHeartbeatMs: 60, heartbeatMs: 600 });
		try {
			link.set(status, "qr-data");
			link.pairing = { phone: "15550100100", code: "ABCD1234" };
			link.chatLogger("sales-chat");
			link.chatLogger("sales-chat"); // a second call must not start a second timer
			jest.advanceTimersByTime(59);
			expect(lines).toEqual([]);
			jest.advanceTimersByTime(1);
			expect(lines).toEqual([`[sales-chat:link] status: ${word}`]);
			jest.advanceTimersByTime(600);
			expect(lines).toEqual([`[sales-chat:link] status: ${word}`, `[sales-chat:link] status: ${word}`]);
		} finally {
			link.dispose();
			info.mockRestore();
		}
	});

	test("dispose stops the beats", () => {
		const lines: string[] = [];
		const info = spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
		const link = new Link({ firstHeartbeatMs: 5, heartbeatMs: 5 });
		try {
			link.chatLogger();
			jest.advanceTimersByTime(12);
			link.dispose();
			expect(lines).toEqual(["[chat:link] status: starting", "[chat:link] status: starting"]);
			jest.advanceTimersByTime(50);
			expect(lines).toHaveLength(2);
		} finally {
			info.mockRestore();
		}
	});
});

describe("WhatsApp link heartbeat: closes", () => {
	const word = (link: Link) => heartbeatState(link.state.status, Reflect.get(link, "closed") as Closed | undefined);

	test("connected -> close reconnect=true -> reconnecting -> Connected -> connected; logged_out wins", () => {
		const info = spyOn(console, "info").mockImplementation(() => {});
		const link = new Link();
		try {
			const log = link.watchingLogger("sales-chat:baileys");
			log.info("Connected to WhatsApp");
			expect(word(link)).toBe("connected");
			log.info("Connection closed (code=428, reconnect=true)");
			expect(word(link)).toBe("reconnecting");
			expect(link.state.status).toBe("connected"); // the link's own state is untouched
			log.info("Connected to WhatsApp");
			expect(word(link)).toBe("connected");
			log.info("Connection closed (code=428, reconnect=true)");
			log.warn("Logged out — not reconnecting.");
			expect(word(link)).toBe("logged_out");
		} finally {
			info.mockRestore();
		}
	});

	test("a close before the first connect keeps the state", () => {
		const info = spyOn(console, "info").mockImplementation(() => {});
		const link = new Link();
		try {
			link.set("waiting-for-scan", "qr");
			link.watchingLogger().info("Connection closed (code=408, reconnect=true)");
			expect(word(link)).toBe("waiting_for_scan");
		} finally {
			info.mockRestore();
		}
	});

	test("repeated failed reconnects stay reconnecting until Connected", () => {
		const info = spyOn(console, "info").mockImplementation(() => {});
		const link = new Link();
		try {
			const log = link.watchingLogger("chat:baileys");
			log.info("Connected to WhatsApp");
			for (let i = 0; i < 3; i++) {
				log.info("Connection closed (code=408, reconnect=true)");
				expect(word(link)).toBe("reconnecting");
			}
			log.info("Connected to WhatsApp");
			expect(word(link)).toBe("connected");
		} finally {
			info.mockRestore();
		}
	});

	test("a close without reconnect is closed; logged_out still wins", () => {
		const info = spyOn(console, "info").mockImplementation(() => {});
		const link = new Link();
		try {
			const log = link.watchingLogger("chat:baileys");
			log.info("Connected to WhatsApp");
			log.info("Connection closed (code=500, reconnect=false)");
			expect(word(link)).toBe("closed");
			expect(link.state.status).toBe("connected");
			log.warn("Logged out — not reconnecting.");
			expect(word(link)).toBe("logged_out");
		} finally {
			info.mockRestore();
		}
	});
});

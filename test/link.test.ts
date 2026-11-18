// The pairing pages know a device's link state only from the Baileys adapter's log lines. BaileysAdapter.initialize()
// replaces the adapter's own logger with chat.getLogger("baileys"), so the watcher has to be the Chat SDK logger.
// This drives the real Chat + BaileysAdapter through initialize(), then has the adapter log through the logger it
// ended up with, exactly as its connection.update handler does.
import { describe, expect, test } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Logger } from "chat";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { asChatAdapter, Link } from "../src/link.ts";

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

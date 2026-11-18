// A real WhatsApp @mention: the text carries "@<digits>" and the mentioned JID sits in contextInfo.mentionedJid,
// by phone JID or by LID, with or without a device suffix. Chat SDK only matches "@<userName>" text, so the package
// marks these itself; without that, group mentions never reach the agent.
import { describe, expect, test } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { WAMessage } from "baileys";
import { Chat } from "chat";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { asChatAdapter } from "../src/link.ts";
import { markNativeMentions, mentionsBot } from "../src/mentions.ts";

// Fictional numbers (US 555 range): the bot, and someone else in the group.
const BOT = ["15550100100:2@s.whatsapp.net", "28012345678901:2@lid"] as const;
const OTHER = "15550100200@s.whatsapp.net";
const NAME = "Clerk";
const group = "120363000000000000@g.us";
const ext = (text: string, mentionedJid: string[]): WAMessage => ({
	key: { remoteJid: group, participant: OTHER },
	message: { extendedTextMessage: { text, contextInfo: { mentionedJid } } },
});

describe("mentionsBot", () => {
	test("a native mention by phone JID or by LID, device suffix or not", () => {
		expect(mentionsBot(ext("@15550100100 o que diz o README?", ["15550100100@s.whatsapp.net"]), BOT, NAME)).toBe(true);
		expect(mentionsBot(ext("@28012345678901 oi", ["28012345678901@lid"]), BOT, NAME)).toBe(true);
	});
	test("a mention inside a quoted reply or an image caption", () => {
		const img: WAMessage = {
			key: { remoteJid: group },
			message: { imageMessage: { caption: "@15550100100 veja", contextInfo: { mentionedJid: ["15550100100@s.whatsapp.net"] } } },
		};
		expect(mentionsBot(img, BOT, NAME)).toBe(true);
	});
	test("typed @<userName> counts; mentioning someone else, or plain text, does not", () => {
		expect(mentionsBot(ext("@Clerk resume", []), BOT, NAME)).toBe(true);
		expect(mentionsBot(ext("@15550100200 você viu?", [OTHER]), BOT, NAME)).toBe(false);
		expect(mentionsBot({ key: { remoteJid: group }, message: { conversation: "bom dia" } }, BOT, NAME)).toBe(false);
		expect(mentionsBot(ext("email clerk@example.com", []), BOT, NAME)).toBe(false);
	});
	test("unknown bot ids (not paired yet) never match a mention", () => {
		expect(mentionsBot(ext("@15550100100", ["15550100100@s.whatsapp.net"]), [undefined, undefined], NAME)).toBe(false);
	});
});

describe("native mention through the real adapter and Chat SDK routing", () => {
	test("reaches the mention handler only when marked; a plain group message does not", async () => {
		const noAuth = { state: { creds: {}, keys: {} }, saveCreds: async () => {} } as unknown as Parameters<typeof createBaileysAdapter>[0]["auth"];
		const adapter = createBaileysAdapter({ auth: noAuth, userName: NAME });
		markNativeMentions(adapter, () => BOT, "test");
		const chat = new Chat({ adapters: { whatsapp: asChatAdapter(adapter) }, state: createMemoryState(), userName: NAME, logger: "silent" });
		const mentions: string[] = [];
		chat.onNewMention(async (_thread, message) => {
			mentions.push(message.text);
		});
		await chat.initialize();
		const deliver = async (raw: WAMessage) => {
			const message = adapter.parseMessage(raw);
			await chat.handleIncomingMessage(asChatAdapter(adapter), message.threadId, message);
		};
		await deliver({
			...ext("@15550100100 o que diz o README?", ["15550100100@s.whatsapp.net"]),
			key: { remoteJid: group, id: "m1", participant: OTHER },
		});
		await deliver({ key: { remoteJid: group, id: "m2", participant: OTHER }, message: { conversation: "bom dia" } });
		expect(mentions).toEqual(["@15550100100 o que diz o README?"]);
	});
});

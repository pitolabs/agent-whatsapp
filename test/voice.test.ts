// WhatsApp voice notes become text before the agent runs: the model never takes audio, so a note that stays an
// attachment would reach it as a bare "[Attached file: audio]" and the agent would say it cannot listen.
import { describe, expect, test } from "bun:test";
import { type Attachment, Message, parseMarkdown } from "chat";
import { type SttConfig, sttConfig, transcribeVoiceNotes } from "../src/voice.ts";

const msg = (text: string, attachments: Attachment[]) =>
	new Message({
		id: "m1",
		threadId: "whatsapp:x",
		text,
		formatted: parseMarkdown(text),
		raw: {},
		author: { userId: "u", userName: "u", fullName: "u", isBot: false, isMe: false },
		metadata: { dateSent: new Date(), edited: false },
		attachments,
	});
const voice = (bytes = "OggS-voice"): Attachment => ({
	type: "audio",
	mimeType: "audio/ogg; codecs=opus",
	name: "audio",
	fetchData: async () => Buffer.from(bytes),
});
const image: Attachment = { type: "image", mimeType: "image/jpeg", fetchData: async () => Buffer.from("jpg") };

function stt(reply: (req: Request) => Response | Promise<Response>): SttConfig & { seen: Request[] } {
	const seen: Request[] = [];
	return {
		url: "http://stt:8000/v1",
		token: "t".repeat(64),
		seen,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			seen.push(req.clone());
			return reply(req);
		}) as typeof fetch,
	};
}

describe("transcribeVoiceNotes", () => {
	test("sends the audio with the app token and puts the transcript where the agent reads text", async () => {
		const cfg = stt(() => Response.json({ text: "revisa o plano de negócio" }));
		const m = msg("", [voice()]);
		await transcribeVoiceNotes(m, cfg, "test");
		const req = cfg.seen[0];
		expect(req.url).toBe("http://stt:8000/v1/audio/transcriptions");
		expect(req.headers.get("authorization")).toBe(`Bearer ${"t".repeat(64)}`);
		const file = (await req.formData()).get("file") as File;
		expect(await file.text()).toBe("OggS-voice");
		expect(m.text).toBe("[Áudio transcrito] revisa o plano de negócio");
		expect(m.attachments).toEqual([]);
	});
	test("keeps the caption and other attachments; transcripts follow in order", async () => {
		const texts = ["primeiro", "segundo"];
		const cfg = stt(() => Response.json({ text: texts.shift() }));
		const m = msg("@Clerk olha", [voice("a"), image, voice("b")]);
		await transcribeVoiceNotes(m, cfg, "test");
		expect(m.text).toBe("@Clerk olha\n\n[Áudio transcrito] primeiro\n\n[Áudio transcrito] segundo");
		expect(m.attachments).toEqual([image]);
	});
	test("a failed transcription still tells the agent a voice note arrived", async () => {
		for (const cfg of [stt(() => new Response("no", { status: 401 })), sttConfig({ url: "http://stt:8000/v1" })]) {
			const m = msg("", [voice()]);
			await transcribeVoiceNotes(m, cfg, "test");
			expect(m.text).toBe("[Áudio recebido, mas não foi possível transcrever]");
			expect(m.attachments).toEqual([]);
		}
	});
	test("a message without audio is left alone and stt is not called", async () => {
		const cfg = stt(() => Response.json({ text: "x" }));
		const m = msg("bom dia", [image]);
		await transcribeVoiceNotes(m, cfg, "test");
		expect(cfg.seen).toEqual([]);
		expect(m.text).toBe("bom dia");
		expect(m.attachments).toEqual([image]);
	});
});

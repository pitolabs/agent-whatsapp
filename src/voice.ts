// WhatsApp voice notes for the agents on linked devices. Mastra sends the model images and PDFs only; an audio attachment would reach it
// as an "[Attached file: audio (audio/ogg)]" note, and Claude cannot take audio anyway. So before the agent runs, each
// audio attachment goes to a speech-to-text server with an OpenAI-compatible `/audio/transcriptions` endpoint (the
// host's own, reached with its own token) and becomes text in the message. The log carries lengths and status codes,
// never the audio or the transcript.
import { type Message, parseMarkdown } from "chat";

export interface SttConfig {
	/** e.g. http://stt:8000/v1 */
	url: string;
	token: string;
	fetch?: typeof fetch;
}

/** The speech-to-text endpoint, or why voice notes are off. The host reads its own environment. */
export function sttConfig(opts: { url?: string; token?: string }): SttConfig | { off: string } {
	if (!opts.url) return { off: "speech-to-text URL is not set" };
	if (!opts.token) return { off: "speech-to-text token is not set" };
	return { url: opts.url.replace(/\/+$/, ""), token: opts.token };
}

/** Voice notes and other audio; a cold stt loads its model first, so allow it time. */
const TIMEOUT_MS = 10 * 60_000;

async function transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string, cfg: SttConfig): Promise<string> {
	const form = new FormData();
	const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "audio";
	form.set("file", new Blob([audio], { type: mimeType }), `voice.${ext}`);
	form.set("response_format", "json");
	const res = await (cfg.fetch ?? fetch)(`${cfg.url}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${cfg.token}` },
		body: form,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`stt answered ${res.status}`);
	const body = (await res.json()) as { text?: unknown };
	if (typeof body.text !== "string") throw new Error("stt reply has no text");
	return body.text.trim();
}

/**
 * Replace the message's audio attachments with their transcripts, in the message text the agent reads. A note that
 * cannot be transcribed becomes a line saying so, so the agent tells the sender instead of seeing nothing.
 */
export async function transcribeVoiceNotes(message: Message, cfg: SttConfig | { off: string }, logPrefix: string): Promise<void> {
	const audios = message.attachments.filter((a) => a.type === "audio" || a.mimeType?.startsWith("audio/"));
	if (!audios.length) return;
	const lines: string[] = [];
	for (const att of audios) {
		const mimeType = att.mimeType ?? "audio/ogg";
		try {
			if ("off" in cfg) throw new Error(cfg.off);
			const data = att.data ?? (await att.fetchData?.());
			if (!data) throw new Error("the audio could not be downloaded");
			// Copy into a plain ArrayBuffer: a Buffer may view a shared pool, which Blob does not accept.
			const audio = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : Uint8Array.from(new Uint8Array(data));
			const t0 = Date.now();
			const text = await transcribe(audio, mimeType, cfg);
			console.info(`[${logPrefix}] voice note in ${message.id}: ${audio.byteLength} bytes -> ${text.length} chars in ${Date.now() - t0} ms`);
			lines.push(text ? `[Áudio transcrito] ${text}` : "[Áudio sem fala reconhecível]");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(`[${logPrefix}] voice note in ${message.id} not transcribed: ${reason}`);
			lines.push("[Áudio recebido, mas não foi possível transcrever]");
		}
	}
	const text = [message.text.trim(), ...lines].filter(Boolean).join("\n\n");
	message.text = text;
	message.formatted = parseMarkdown(text);
	message.attachments = message.attachments.filter((a) => !audios.includes(a));
}

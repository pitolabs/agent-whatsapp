// "digitando…" for a whole turn, on any linked device.
//
// Mastra sends WhatsApp's "composing" only when the run's status changes (start, a tool call, text), and WhatsApp
// drops it after about 25 s without a refresh, so during a slow tool it vanished. And every linked device is always
// "unavailable" (markOnlineOnConnect: false in whatsapp.ts, so the phone keeps its notifications); WhatsApp may not
// show "composing" from an offline account [INFERENCE, not tested on a phone]. So, during each turn, the device is
// "available" (counted across conversations) and "composing" is re-sent every few seconds; both best-effort: a
// presence failure never fails the turn.

import type { BaileysAdapter } from "chat-adapter-baileys";

export type Presence = Pick<BaileysAdapter, "postMessage" | "startTyping" | "setPresence">;

/** WhatsApp drops "composing" after ~25 s; refreshed well before that. */
const TYPING_EVERY_MS = 8000;

/** Runs a best-effort WhatsApp call: a failure is logged (its error name only), never thrown. */
export const quietly = (p: Promise<unknown>, log: string, what: string): void => {
	p.catch((e) => console.warn(`${log} ${what} failed (${e instanceof Error ? e.name : "unknown"})`));
};

/** Wraps each turn (the agent run of one batch) in "available" + "composing" kept alive until the run ends. `log`: e.g. "[clerk]". */
export function turnPresence(wa: Presence, log: string, every = TYPING_EVERY_MS) {
	let active = 0;
	return async function during<T>(threadId: string, run: () => Promise<T>): Promise<T> {
		if (active++ === 0) quietly(wa.setPresence("available"), log, "presence available");
		quietly(wa.startTyping(threadId), log, "typing");
		const timer = setInterval(() => quietly(wa.startTyping(threadId), log, "typing"), every);
		try {
			return await run();
		} finally {
			clearInterval(timer);
			if (--active === 0) quietly(wa.setPresence("unavailable"), log, "presence unavailable");
		}
	};
}

// WhatsApp link state per linked device (one per number the app runs), read from the Baileys adapter's own log
// lines. The adapter exposes no connection state, and BaileysAdapter.initialize() replaces any logger given to the
// adapter with chat.getLogger("baileys"), i.e. a child of the Chat SDK logger. So the watcher must be the Chat SDK
// logger itself (channels.chatOptions.logger) and every child must keep watching.
import type { Adapter, Logger } from "chat";
import type { BaileysAdapter } from "chat-adapter-baileys";

export interface LinkState {
	status: "starting" | "waiting-for-scan" | "connected" | "logged-out";
	qr?: string;
	since: string;
}

export class Link {
	state: LinkState = { status: "starting", since: new Date().toISOString() };
	/**
	 * A pairing by phone number instead of the QR: the number typed on the pairing page (digits, no +), then the code
	 * WhatsApp gave for it. The adapter reads `phone` when it asks (its config's phoneNumber getter, whatsapp.ts).
	 * Cleared once the device is linked or logged out.
	 */
	pairing?: { phone: string; code?: string };
	/** Set by linkedDevice: has the adapter ask WhatsApp for a code now, on a fresh socket. */
	askNow?: () => void;
	/**
	 * Set by linkedDevice: called when the adapter is about to open a new socket after one closed (not after a
	 * successful pairing's restart). It drops what a pairing-code request left in the credentials.
	 */
	beforeReconnect?: () => void;

	set(status: LinkState["status"], qr?: string): void {
		this.state = { status, qr, since: new Date().toISOString() };
		if (status === "connected" || status === "logged-out") this.pairing = undefined;
	}

	/** Each call is a new attempt (another number, or a new code after one expired): the old code is dropped. */
	requestPairingCode(phone: string): void {
		this.pairing = { phone };
		this.askNow?.();
	}

	pairingCode(code: string): void {
		if (this.pairing) this.pairing = { ...this.pairing, code };
	}

	/** A console logger that also turns the adapter's "Connected to WhatsApp" / "Logged out" lines into this link's state. */
	watchingLogger(prefix = "chat"): Logger {
		const tag = `[${prefix}]`;
		return {
			child: (p) => this.watchingLogger(`${prefix}:${p}`),
			debug: () => {},
			info: (message, ...args) => {
				if (message === "Connected to WhatsApp") this.set("connected");
				// The adapter logs this, then opens the next socket in the same tick: the moment to fix the credentials.
				if (/^Connection closed \(.*reconnect=true\)$/.test(message)) {
					if (this.pairing) this.pairing = { phone: this.pairing.phone }; // its code died with the socket
					this.beforeReconnect?.();
				}
				console.info(tag, message, ...args);
			},
			warn: (message, ...args) => {
				if (message.startsWith("Logged out")) this.set("logged-out");
				console.warn(tag, message, ...args);
			},
			error: (message, ...args) => console.error(tag, message, ...args),
		};
	}
}

/**
 * BaileysAdapter.reply(message, content) is a WhatsApp quoted-reply extension whose signature clashes with Chat SDK's
 * optional reply(threadId, messageId, content). Mastra posts through thread.post(), never thread.reply(), so the
 * clash is type-only; the adapter is otherwise a Chat SDK Adapter.
 */
export const asChatAdapter = (a: BaileysAdapter): Adapter => a as unknown as Adapter;

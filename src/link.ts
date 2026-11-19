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

export interface LinkOptions {
	/** Delay of the first status heartbeat after chatLogger() (default 60 s). */
	firstHeartbeatMs?: number;
	/** Interval of the status heartbeats after the first (default 600 s). */
	heartbeatMs?: number;
}

/** How the last socket closed, after the last "Connected to WhatsApp" (heartbeat only; the link's own state is untouched). */
export type Closed = "reconnecting" | "closed";

/** The state word of the heartbeat: the status with `_` for `-`; a connected link whose socket closed is `reconnecting` or `closed`. */
export const heartbeatState = (status: LinkState["status"], closed?: Closed): string => (status === "connected" && closed ? closed : status.replace(/-/g, "_"));

export class Link {
	state: LinkState = { status: "starting", since: new Date().toISOString() };
	private heartbeat?: ReturnType<typeof setTimeout>;
	private disposed = false;
	/** Heartbeat only: set by every "Connection closed (...)" line, cleared by any set() (so by the next "Connected to WhatsApp"). */
	private closed?: Closed;

	constructor(private readonly options: LinkOptions = {}) {}

	/**
	 * The Chat SDK logger of this link, and the start of its status heartbeat: `[<line>:link] status: <state>` on the
	 * console, once ~60 s later and then every 600 s. `line` is the root prefix the `[<line>:baileys]` lines carry. Log
	 * monitoring may read the latest one as the line's state, so it never carries a number, JID or name.
	 */
	chatLogger(line = "chat"): Logger {
		if (!this.heartbeat && !this.disposed) {
			const beat = () => {
				console.info(`[${line}:link] status: ${heartbeatState(this.state.status, this.closed)}`);
				this.heartbeat = setTimeout(beat, this.options.heartbeatMs ?? 600_000);
				this.heartbeat.unref();
			};
			this.heartbeat = setTimeout(beat, this.options.firstHeartbeatMs ?? 60_000);
			this.heartbeat.unref();
		}
		return this.watchingLogger(line);
	}

	/** Stops the heartbeat for good. */
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.heartbeat);
		this.heartbeat = undefined;
	}
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
		this.closed = undefined;
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
				if (/^Connection closed \(/.test(message)) this.closed = /reconnect=true\)$/.test(message) ? "reconnecting" : "closed";
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

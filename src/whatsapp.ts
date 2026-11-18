// A WhatsApp linked device as a Chat SDK adapter on Mastra Channels (Baileys, WhatsApp Web, unofficial). One per agent
// and number. Each keeps its session in its own folder (on a data volume, never in the image or the repo), and its
// own link state for its pairing page.
import * as fs from "node:fs";
import { useMultiFileAuthState } from "baileys";
import type { Adapter } from "chat";
import { type BaileysAdapter, BaileysFormatConverter, createBaileysAdapter } from "chat-adapter-baileys";
import pino from "pino";
import { asChatAdapter, Link } from "./link.ts";
import { markNativeMentions } from "./mentions.ts";

export interface LinkedDevice {
	/** Chat SDK adapter, for the agent's channels config. */
	adapter: Adapter;
	baileys: BaileysAdapter;
	link: Link;
	/** The bot's own JID and LID (creds.me), known once paired. */
	botIds: () => readonly (string | null | undefined)[];
	/** Opens the WebSocket. The adapter reconnects by itself unless WhatsApp logs the device out. */
	connect: () => Promise<void>;
}

type MdNode = { type: string; url?: string; ordered?: boolean | null; start?: number | null; value?: string; children?: MdNode[] };

/**
 * How the agents write for WhatsApp, for every agent's instructions. The model writes Markdown; WhatsAppConverter
 * turns it into WhatsApp's own marks (https://faq.whatsapp.com/539178204879377: *bold*, _italic_, ~strike~, `code`,
 * ```monospace```, "- " / "1. " lists, "> " quotes; no tables, headings or link text). Keep the two in step.
 */
export const WHATSAPP_FORMAT = `Formato (WhatsApp): escreva Markdown simples; o canal converte para o WhatsApp, que só tem negrito, itálico, riscado, código, listas e citação.
- Use **negrito** (dois asteriscos: um só vira itálico), _itálico_, ~~riscado~~, \`código\`, listas com "- " ou "1. " e "> citação".
- Nas mensagens, nunca use tabela: o WhatsApp não tem. Para comparar itens, uma linha de lista por item (ex.: "- **Item A:** 2 × R$ 10,00 = **R$ 20,00**"). Documento com tabela, para imprimir ou assinar: send_pdf, se você tiver.
- Nada de título (#): uma linha em **negrito** faz esse papel. Listas sem subníveis.
- Link: a URL por extenso, sozinha na linha; nunca [texto](url).
- Parágrafos curtos, separados por uma linha em branco.`;

/**
 * Markdown → WhatsApp text, for the agents' replies. The stock converter prints every link as `text (url)`, which
 * doubles a bare URL (the parser autolinks it, so text === url) and reads badly; it drops headings; and it glues a
 * table's cells and a nested list's items into one run of text. Here a link whose text is its own URL (or an autolink)
 * is the URL alone, `[text](url)` becomes `text: url`, a heading is a bold line, a table is one list line per row
 * ("- label — header: value · header: value"), and a list item's later lines are indented under it.
 */
export class WhatsAppConverter extends BaileysFormatConverter {
	fromAst(ast: Parameters<BaileysFormatConverter["fromAst"]>[0]): string {
		// mdast's Root children are a wide union; MdNode is the structural subset the renderer reads.
		const blocks: MdNode[] = ast.children;
		return blocks
			.map((n) => this.render(n))
			.filter(Boolean)
			.join("\n\n");
	}
	private render(node: MdNode): string {
		switch (node.type) {
			case "link": {
				const text = (node.children ?? []).map((c) => this.render(c)).join("");
				const url = node.url ?? "";
				if (!url) return text;
				const bare = text === url || `mailto:${text}` === url || text.replace(/\/$/, "") === url.replace(/\/$/, "");
				return bare ? url : `${text}: ${url}`;
			}
			case "heading":
				return `*${(node.children ?? []).map((c) => this.render(c)).join("")}*`;
			case "strong":
				return `*${(node.children ?? []).map((c) => this.render(c)).join("")}*`;
			case "emphasis":
				return `_${(node.children ?? []).map((c) => this.render(c)).join("")}_`;
			case "delete":
				return `~${(node.children ?? []).map((c) => this.render(c)).join("")}~`;
			case "paragraph":
				return (node.children ?? []).map((c) => this.render(c)).join("");
			case "listItem":
				return (node.children ?? []).map((c) => this.render(c)).join("\n");
			case "list":
				return (node.children ?? [])
					.map((item, i) => {
						const [first, ...more] = this.render(item).split("\n");
						return [`${node.ordered ? `${(node.start ?? 1) + i}.` : "-"} ${first}`, ...more.map((l) => `   ${l}`)].join("\n");
					})
					.join("\n");
			case "table": {
				const [head = [], ...rows] = (node.children ?? []).map((row) => (row.children ?? []).map((cell) => this.render(cell).trim()));
				if (rows.length === 0) return head.filter(Boolean).join(" · ");
				return rows
					.map((cells) => {
						const rest = cells
							.slice(1)
							.map((v, i) => (v && head[i + 1] ? `${head[i + 1]}: ${v}` : v))
							.filter(Boolean);
						return `- ${[cells[0], rest.join(" · ")].filter(Boolean).join(" — ")}`;
					})
					.join("\n");
			}
			case "blockquote":
				return (node.children ?? [])
					.map((c) =>
						this.render(c)
							.split("\n")
							.map((l) => `> ${l}`)
							.join("\n"),
					)
					.join("\n");
			case "inlineCode":
				return `\`${node.value ?? ""}\``;
			case "code":
				return `\`\`\`\n${node.value ?? ""}\n\`\`\``;
			case "break":
				return "\n";
			case "thematicBreak":
				return "";
			default:
				return node.value ?? (node.children ?? []).map((c) => this.render(c)).join("");
		}
	}
}

/**
 * Drops what a pairing-code request wrote before the pairing was done: `me` without a device id (a real one, after
 * pair-success, is "<number>:<device>@…") on an unregistered device, and the code. True when it changed anything.
 */
export function dropProvisionalIdentity(creds: { registered?: boolean; me?: { id: string }; pairingCode?: string }): boolean {
	if (creds.registered || !creds.me || creds.me.id.includes(":")) return false;
	creds.me = undefined;
	creds.pairingCode = undefined;
	return true;
}

export async function linkedDevice(opts: { authDir: string; userName: string; logPrefix: string }): Promise<LinkedDevice> {
	fs.mkdirSync(opts.authDir, { recursive: true, mode: 0o700 });
	const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
	// A pairing-code request saves its provisional identity to creds.json: one left by a restart mid-pairing would make
	// the first socket log in on it (401). Drop it now, and on disk.
	if (dropProvisionalIdentity(state.creds)) await saveCreds();
	const link = new Link();
	const baileys = createBaileysAdapter({
		adapterName: "whatsapp",
		auth: { state, saveCreds },
		userName: opts.userName,
		// Used only until the Chat SDK initializes the adapter, which then swaps in chat.getLogger("baileys"); that is
		// why each agent passes link.watchingLogger() as channels.chatOptions.logger too.
		logger: link.watchingLogger(opts.logPrefix),
		onQR: (qr) => link.set("waiting-for-scan", qr),
		// Pairing by phone number (the pairing page's form, for a phone without a camera). The adapter keeps this config
		// object and reads phoneNumber at each QR event of an unregistered socket, so a number typed after boot is used
		// on the next one; it then calls onPairingCode with the code to show.
		get phoneNumber() {
			return link.pairing?.phone;
		},
		onPairingCode: (code) => link.pairingCode(code),
		// Never show the number as online, never pull the whole chat history: agents react to new messages only.
		// Baileys' own pino logger at "info" prints the pairing handshake (device keys) and message metadata to stdout,
		// which lands in `docker compose logs`; keep only its errors.
		socketOptions: { markOnlineOnConnect: false, syncFullHistory: false, logger: pino({ level: "error" }) },
	});
	// The adapter's converter is a private field with no setter; the single assignment below is the one place that knows.
	const withConverter: { _converter: BaileysFormatConverter } = baileys as unknown as { _converter: BaileysFormatConverter };
	withConverter._converter = new WhatsAppConverter();
	// Pairing by phone number, two Baileys traps (2026-11-11, seen in the logs):
	// - requestPairingCode writes creds.me (the number, no device id) before the pairing is done; a socket opened on
	//   such credentials logs in as a linked device instead of registering, and WhatsApp answers 401: logged out. A
	//   pairing socket is replaced every few minutes ("QR refs attempts ended", 408), so before each new socket the
	//   provisional creds.me goes (a real one, after pair-success, carries the device id: "<number>:<n>@…").
	// - the adapter asks for a code once per socket, at its QR events. A number typed late in a socket's life got a
	//   code that died seconds later. So each typed number ends the current socket: the adapter opens a fresh one and
	//   asks for its code there, which then lives for the whole socket (minutes); a later socket asks for a new one.
	link.beforeReconnect = () => {
		if (dropProvisionalIdentity(state.creds)) void saveCreds();
	};
	const internals = baileys as unknown as { _socket: { end(error: Error | undefined): void } | null };
	link.askNow = () => {
		if (state.creds.registered) return;
		internals._socket?.end(new Error("pairing by phone number: a fresh socket for the code"));
	};
	const botIds = () => [state.creds.me?.id, state.creds.me?.lid];
	markNativeMentions(baileys, botIds, opts.logPrefix);
	return { adapter: asChatAdapter(baileys), baileys, link, botIds, connect: () => baileys.connect() };
}

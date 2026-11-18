// Native WhatsApp @mentions, sender phone numbers and companion messages, shared by every agent on a linked device.
import { areJidsSameUser, normalizeMessageContent, proto, type WAMessage } from "baileys";
import type { BaileysAdapter } from "chat-adapter-baileys";

/** Channel messages carry the platform payload as `unknown`; a Baileys message has a `key` with a `remoteJid`. */
export function isBaileysMessage(raw: unknown): raw is WAMessage {
	if (!raw || typeof raw !== "object" || !("key" in raw)) return false;
	const key = raw.key;
	return !!key && typeof key === "object" && "remoteJid" in key && typeof key.remoteJid === "string";
}

const { AssociationType } = proto.MessageAssociation;
/** Associations that are another copy or a part of a message already received; a photo album's items are not. */
const COMPANION: ReadonlySet<number> = new Set([
	AssociationType.MOTION_PHOTO,
	AssociationType.HD_IMAGE_DUAL_UPLOAD,
	AssociationType.HD_VIDEO_DUAL_UPLOAD,
	AssociationType.HEVC_VIDEO_DUAL_UPLOAD,
]);

/**
 * A message WhatsApp sends alongside one already received: the short video of an iPhone Live Photo or Android motion
 * photo, or the HD copy of a photo or video sent in HD. Baileys unwraps it (`associatedChildMessage`) into a plain
 * caption-less video or image, so without this check an agent sees "a video" nobody sent. The association may sit on
 * the outer message or on the unwrapped child.
 */
export function isCompanionMessage(raw: WAMessage): boolean {
	const outer = raw.message?.messageContextInfo?.messageAssociation;
	const inner = normalizeMessageContent(raw.message)?.messageContextInfo?.messageAssociation;
	const type = (inner ?? outer)?.associationType;
	return typeof type === "number" && COMPANION.has(type);
}

const phoneOf = (jid: string | null | undefined): string | undefined => /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? "")?.[1];

/**
 * The sender's phone number (E.164 digits without "+"), or undefined. WhatsApp may address a sender by LID (an
 * opaque id) instead of the phone JID; Baileys then puts the phone JID in `participantAlt` (groups) or
 * `remoteJidAlt` (direct messages). A device suffix (":3") is ignored.
 */
export function senderPhone(raw: WAMessage): string | undefined {
	const key = raw.key;
	const isGroup = (key.remoteJid ?? "").endsWith("@g.us");
	return phoneOf(isGroup ? key.participant : key.remoteJid) ?? phoneOf(isGroup ? key.participantAlt : key.remoteJidAlt);
}

/**
 * Whether a group message @mentions the bot. A real WhatsApp mention puts the mentioned JIDs in the carrying
 * message's `contextInfo.mentionedJid` (phone JID or LID) and only "@<digits>" in the text, so neither Chat SDK's
 * "@<userName>" text match nor the adapter (which never reads contextInfo) sees it. Typing "@<userName>" also counts.
 * `botIds` are the bot's own JID and LID; device suffixes (":2") are ignored.
 */
export function mentionsBot(raw: WAMessage, botIds: readonly (string | null | undefined)[], userName: string): boolean {
	const content = normalizeMessageContent(raw.message);
	if (!content) return false;
	const mentioned = Object.values(content).flatMap((part) => {
		if (!part || typeof part !== "object" || !("contextInfo" in part)) return [];
		const ctx = part.contextInfo;
		return ctx && typeof ctx === "object" && "mentionedJid" in ctx && Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
	});
	if (mentioned.some((jid) => typeof jid === "string" && botIds.some((id) => !!id && areJidsSameUser(jid, id)))) return true;
	const text =
		content.conversation ??
		content.extendedTextMessage?.text ??
		content.imageMessage?.caption ??
		content.documentMessage?.caption ??
		content.videoMessage?.caption ??
		"";
	const name = userName.replace(/[^A-Za-z0-9]/g, "");
	return !!name && new RegExp(`(?<!\\w)@${name}\\b`, "i").test(text);
}

/**
 * Native WhatsApp @mentions: the adapter's parseMessage never reads contextInfo.mentionedJid, and Chat SDK only
 * matches "@<userName>" text. Wrap parseMessage so group messages carry `isMention` before Chat SDK routes them (it
 * keeps an isMention already set). `botIds` reads the bot's JID and LID at parse time (creds.me, filled at pairing).
 */
export function markNativeMentions(adapter: BaileysAdapter, botIds: () => readonly (string | null | undefined)[], logPrefix: string): void {
	const parse = adapter.parseMessage.bind(adapter);
	adapter.parseMessage = (raw) => {
		const message = parse(raw);
		if (raw.key.remoteJid?.endsWith("@g.us")) {
			message.isMention = mentionsBot(raw, botIds(), adapter.userName);
			// Shapes only (digits masked), never text: enough to see why a group message did or did not count.
			const mask = (s: string) => s.replace(/\d/g, "9");
			const content = normalizeMessageContent(raw.message);
			const kinds = content ? Object.keys(content).filter((k) => k !== "messageContextInfo") : [];
			const mentioned = content
				? Object.values(content).flatMap((p) => (p && typeof p === "object" && "contextInfo" in p && p.contextInfo?.mentionedJid) || [])
				: [];
			console.info(
				`[${logPrefix}] group message ${message.id}: isMention=${message.isMention} kinds=${kinds.join(",")} mentioned=${mentioned.map(mask).join(",") || "-"} bot=${botIds()
					.map((b) => mask(b ?? "?"))
					.join(",")}`,
			);
		}
		return message;
	};
}

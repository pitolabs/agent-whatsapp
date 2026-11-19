// The WhatsApp side of an agent's channel handler, on one turn per burst of messages from one sender (burst.ts: 2 s
// of quiet, 8 s at most, closed early when someone else writes). Here: admission, and the turn's preparation. That
// turn sees every message of the burst: each one's voice notes transcribed, each one's files in the conversation's
// inbox, the confirmation gate fed each message in arrival order; the burst handler then merges the texts into the
// last message and runs the agent once.
//
// The gate's receipt is taken in `accept`, when the message arrives, before any buffering or waiting: a "sim" that
// arrives while the previous turn is still preparing a proposal keeps an earlier receipt than that proposal, so it
// cannot approve something the person had not seen (@pitolabs/agent-docs' approval gate).

import type { ChannelHandler } from "@mastra/core/channels";
import type { RequestContext } from "@mastra/core/request-context";
import { type ApprovalGate, grantPass, type InboxFile } from "@pitolabs/agent-docs/mastra";
import type { WAMessage } from "baileys";
import type { BurstTiming, TurnQueue } from "./burst.ts";
import { burstHandler } from "./burst-mastra.ts";
import { filesOf } from "./inbox.ts";
import { isBaileysMessage } from "./mentions.ts";
import { type SttConfig, transcribeVoiceNotes } from "./voice.ts";

/** Admits one raw WhatsApp message: who sends it (the configured phone, used for the pass and the gate) and what the agent's request context gets. */
export type Admit = (raw: WAMessage) => { admit: true; sender: string; stamp: (ctx: RequestContext) => void } | { admit: false; reason: string };

/** Options every agent handler forwards (tests pass `batching: false` to run each message as its own turn). */
export interface HandlerOptions {
	turns?: Pick<TurnQueue, "run">;
	/** Omitted: 2 s of quiet, 8 s at most. `false`: no buffering, each admitted message is its own turn. */
	batching?: BurstTiming | false;
}

export interface WhatsAppHandlerDeps extends HandlerOptions {
	/** Log prefix without brackets, e.g. "clerk". */
	log: string;
	admit: Admit;
	gate: ApprovalGate;
	stt: SttConfig | { off: string };
	/** Request-context key that receives the approved proposal's summary (e.g. "clerkApproved"). Omit for agents that never propose. */
	approvedKey?: string;
	/** Called at each turn once the pass is granted (e.g. to remember where someone last wrote). A throw is logged, never fails the turn. */
	onTurn?: (turn: { conversation: string; sender: string }) => void | Promise<void>;
}

interface Accepted {
	sender: string;
	stamp: (ctx: RequestContext) => void;
	receipt: number;
}

export function whatsappHandler(deps: WhatsAppHandlerDeps): ChannelHandler {
	return burstHandler<Accepted>({
		timing: deps.batching,
		turns: deps.turns,
		sender: (a) => a.sender,
		accept: (_thread, message) => {
			if (!isBaileysMessage(message.raw)) return undefined;
			const verdict = deps.admit(message.raw);
			if (!verdict.admit) {
				console.info(`[${deps.log}] ignored message ${message.id}: ${verdict.reason}`);
				return undefined;
			}
			return { sender: verdict.sender, stamp: verdict.stamp, receipt: deps.gate.receive() };
		},
		turn: async ({ key: conversation, items, last, dispatch }) => {
			const sender = last.accepted.sender;
			if (items.length > 1) console.info(`[${deps.log}] one turn for ${items.length} messages from ${sender} in ${conversation}`);
			let approved: string | undefined;
			for (const it of items) approved = deps.gate.onMessage(conversation, sender, it.message.text, it.accepted.receipt);
			const files: InboxFile[] = [];
			for (const it of items) files.push(...(await filesOf(it.message)));
			deps.gate.setFiles(conversation, files);
			// Before dispatch merges the texts: each note becomes text in its own message, in order.
			for (const it of items) await transcribeVoiceNotes(it.message, deps.stt, deps.log);
			const rc = last.ctx.requestContext;
			grantPass(rc, { conversation, sender });
			if (deps.onTurn) {
				try {
					await deps.onTurn({ conversation, sender });
				} catch (e) {
					console.warn(`[${deps.log}] onTurn failed (${e instanceof Error ? e.name : "error"})`);
				}
			}
			last.accepted.stamp(rc);
			if (deps.approvedKey && approved) rc.set(deps.approvedKey, approved);
			await dispatch();
		},
	});
}

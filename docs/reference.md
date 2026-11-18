# Reference

Every export of `@pitolabs/agent-whatsapp` (one entry point, `.`). How to wire them together: the [guide](guide.md).

## Device and link

|Export|What it does|
|---|---|
|`linkedDevice({ authDir, userName, logPrefix })`|Opens the session folder and returns `{ adapter, baileys, link, botIds, connect }`; installs `WhatsAppConverter` and native mention marking; Baileys' own logger is at `error`; never online, never full history.|
|`Link`|Link state (`starting`, `waiting-for-scan`, `connected`, `logged-out`, the QR), the pairing-by-number attempt, and `watchingLogger(prefix)`.|
|`asChatAdapter(baileys)`|The Baileys adapter typed as a Chat SDK `Adapter` (its `reply` signature differs; type-only).|
|`dropProvisionalIdentity(creds)`|Removes what a pairing-code request left in unregistered credentials; true when it changed them.|

## Handler

|Export|What it does|
|---|---|
|`whatsappHandler({ log, admit, gate, stt, approvedKey?, turns?, batching? })`|The `ChannelHandler` (see the guide's pipeline). `approvedKey` receives the gate's approved summary in the request context.|
|`Admit`, `HandlerOptions`, `WhatsAppHandlerDeps`|Its types. `batching: false` runs each message as its own turn (tests).|
|`burstHandler({ accept, sender, turn?, timing?, turns?, key? })`|The generic Mastra burst handler under `whatsappHandler`.|
|`mergeInto(target, messages)`|Texts (blank-line separated) and attachments of `messages` into `target`, `formatted` re-parsed.|
|`createBurstQueue({ run, group?, timing?, turns? })`, `TurnQueue`, `DEFAULT_TIMING`|Framework-free batching: `push(key, item)` settles with its batch's run.|
|`filesOf(message)`|The archivable attachments (PDF, images, office files, ≤ 16 MB), downloaded once and served again to the model.|

## Senders and groups

|Export|What it does|
|---|---|
|`isBaileysMessage(raw)`|Type guard for a raw Baileys message.|
|`senderPhone(raw)`|E.164 digits of the sender, from the JID or its LID alternative.|
|`samePhone(a, b)`, `withoutNinthDigit(phone)`|Brazilian mobiles compared with or without the ninth digit.|
|`mentionsBot(raw, botIds, userName)`|A native mention of the bot (`contextInfo.mentionedJid`) or a typed `@<userName>`.|
|`markNativeMentions(adapter, botIds, logPrefix)`|Sets `isMention` on group messages before the Chat SDK routes them; logs shapes with digits masked.|
|`isCompanionMessage(raw)`|The motion-photo video or HD copy WhatsApp sends after a photo.|

## Pairing

|Export|What it does|
|---|---|
|`pairingRoutes(path, title, phone, link, middleware)`|GET and POST routes for Mastra's `apiRoutes`, behind `middleware`.|
|`pairingPage`, `pairingRequest`|The two Hono handlers. The page is `no-store` with a strict CSP; the POST takes same-origin requests only.|
|`pairingDigits(typed)`|10–15 digits, country code first, or undefined.|

## Voice, presence, formatting

|Export|What it does|
|---|---|
|`sttConfig({ url?, token? })`|`SttConfig` or `{ off: "speech-to-text URL is not set" \| "speech-to-text token is not set" }`.|
|`transcribeVoiceNotes(message, cfg, logPrefix)`|Replaces audio attachments with their transcripts in the message text.|
|`turnPresence(wa, log, every?)`, `quietly(p, log, what)`, `Presence`|"Digitando…" during a turn; presence failures are logged, never thrown.|
|`WhatsAppConverter`|Markdown → WhatsApp marks; tables become list lines, nested lists stay indented.|
|`WHATSAPP_FORMAT`|The formatting rules for an agent's instructions (Portuguese).|

## Logs

Lines start with `[<log>]`. They carry message ids, the configured `sender` of a turn that merged several messages,
what your `Admit` puts in a refusal's `reason`, byte and character counts, and status codes; never message text,
transcripts, QR codes or pairing codes.

# Guide

How to put a Mastra agent on a WhatsApp number with this package. The exports are listed in the
[reference](reference.md); setup and releases in [CONTRIBUTING](../CONTRIBUTING.md).

## The pipeline

```text
WhatsApp ──► linked device (Baileys, chat-adapter-baileys)
         ──► Chat SDK routes: direct message, mention, subscribed thread
         ──► whatsappHandler
               accept (on arrival):  isBaileysMessage → your Admit → gate receipt
               burst (per thread):   2 s quiet, 8 s max, closed when another sender writes
               turn (one at a time): gate.onMessage per message → files to the inbox
                                     → voice notes to text → grantPass → your stamp
                                     → texts and attachments merged into the last message
         ──► your agent, once
```

## 1. One linked device per number

```ts
const device = await linkedDevice({ authDir: "/data/whatsapp-auth", userName: "Clerk", logPrefix: "clerk" });
```

- `authDir` holds the WhatsApp session (created `0700`). Keep it on a persistent volume, never in an image or a
  repository; whoever has it can read and send as the number.
- `userName` is the name a typed `@Clerk` matches in groups; pass the same to the Chat SDK (`channels.userName`).
- Pass `device.link.chatLogger("<line>")` as `channels.chatOptions.logger`: the adapter swaps its own logger for the
  Chat SDK's at initialization, and the link state (for the pairing page) is read from those log lines. It also logs
  `[<line>:link] status: <state>` about a minute after start and every ten minutes (`starting`, `waiting_for_scan`,
  `connected`, `reconnecting`, `closed`, `logged_out`), for log-based monitoring; never a number or a name.
- Call `device.connect()` after `channels.initialize(mastra)`, and not during a build or tests.

## 2. Admission

`Admit` receives the raw Baileys message and answers `{ admit: false, reason }` (logged as `ignored message <id>:
<reason>`) or `{ admit: true, sender, stamp }`. `sender` is the configured identity (use the number from your
configuration, not the one on the wire); `stamp(ctx)` puts what the agent needs into the request context.

- Phones: `senderPhone(raw)` gives the digits of the sender's JID (the LID's phone alternative when WhatsApp uses a
  LID). A Brazilian account's JID may lack the ninth digit the person types: compare with `samePhone`, never `===`.
- Groups: after a first mention the Chat SDK subscribes the thread and routes every later message there with no @.
  An agent that sits in groups must call `mentionsBot(raw, device.botIds(), userName)` in its `Admit` and refuse a
  group message without one.
- Companion messages (the video of a Live Photo, the HD copy of a photo) look like new media: drop them with
  `isCompanionMessage(raw)`.

## 3. Pairing page

```ts
apiRoutes: pairingRoutes("/whatsapp", "Clerk", "do número da loja", device.link, requireLogin),
```

`requireLogin` is your Hono middleware: the routes sit outside `/api/*`, so a server-wide guard on `/api/*` does not
cover them, and the QR is a login credential for the number. The GET page shows the QR or, through `?numero`, a form
that asks WhatsApp for an 8-character pairing code. A device logged out by WhatsApp needs a process restart for a new
QR.

## 4. Speech-to-text

`sttConfig({ url, token })` returns the endpoint, or `{ off: reason }` when either is missing; read your own
environment variables. Each audio attachment is posted as `file` to `<url>/audio/transcriptions` with
`Authorization: Bearer <token>` and `response_format=json`, with a ten-minute timeout (a cold server loads its model
first). The text replaces the attachment as `[Áudio transcrito] …`; a failure becomes
`[Áudio recebido, mas não foi possível transcrever]`, so the agent tells the person.

## 5. Presence

`turnPresence(device.baileys, "[clerk]")` returns `during(threadId, run)`: the number shows as available and
"digitando…" for the whole turn. Wrap the default handler of each call:

```ts
const during = turnPresence(device.baileys, "[clerk]");
const withTyping: ChannelHandler = (thread, message, defaultHandler, ctx) =>
	handler(thread, message, (t, m) => during(t.id, () => defaultHandler(t, m)), ctx);
```

## 6. Confirmation gate and files

`whatsappHandler` needs an `ApprovalGate` from `@pitolabs/agent-docs`. It takes each message's receipt on arrival,
feeds the gate in arrival order, and keeps the turn's PDFs, images and office files (16 MB each at most) as the
conversation's inbox; the model reads the same bytes, downloaded once. `grantPass` marks the run as a WhatsApp turn:
tools that act for a person check it with `whoOf`.

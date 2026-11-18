// Pairing by phone number, for a phone without a camera: the number typed on the pairing page (a form that does not
// reload) reaches the Baileys adapter's own pairing-code request on a fresh socket, the code it gets back is what the
// page shows, and a socket replaced mid-pairing does not log the device out.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { Link } from "../src/link.ts";
import { pairingDigits, pairingPage, pairingRequest } from "../src/pairing.ts";
import { linkedDevice } from "../src/whatsapp.ts";

// Fictional numbers (US 555 range).
const NUMBER = "15550100100";
const OTHER_FORM = "15550100101";

function app(link: Link) {
	const a = new Hono();
	a.get("/whatsapp", pairingPage("/whatsapp", "Clerk", "do número da loja", link));
	a.post("/whatsapp", pairingRequest("/whatsapp", "Clerk", link));
	return a;
}
const post = (a: Hono, phone: string, headers: Record<string, string> = {}) =>
	a.request("/whatsapp", { method: "POST", body: new URLSearchParams({ phone }), headers: { "Sec-Fetch-Site": "same-origin", ...headers } });
const html = async (a: Hono, url = "/whatsapp") => (await a.request(url)).text();

describe("pairing by phone number", () => {
	test("the QR page links to a number form that does not reload; then the code WhatsApp gave shows, until linked", async () => {
		const link = new Link();
		link.set("waiting-for-scan", "qr-data");
		const a = app(link);
		expect(await html(a)).toContain('href="/whatsapp?numero"');
		const form = await html(a, "/whatsapp?numero");
		expect(form).toContain('name="phone"');
		expect(form).not.toContain('http-equiv="refresh"'); // a reload while typing loses the number

		const r = await post(a, "+1 (555) 010-0100");
		expect(r.status).toBe(303);
		expect(link.pairing).toEqual({ phone: NUMBER });
		expect(await html(a)).toContain("Pedindo o código");

		link.pairingCode("ABCD1234");
		expect(await html(a)).toContain("ABCD-1234");
		// A new QR (the adapter rotates them) keeps the code on the page.
		link.set("waiting-for-scan", "qr-2");
		expect(await html(a)).toContain("ABCD-1234");

		link.set("connected");
		expect(link.pairing).toBeUndefined();
		expect(await html(a)).not.toContain("ABCD");
	});

	test("refuses a malformed number and a post from another site, and ignores a post once linked", async () => {
		const link = new Link();
		link.set("waiting-for-scan", "qr-data");
		const a = app(link);
		expect((await post(a, "1234")).status).toBe(400);
		expect((await post(a, NUMBER, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		expect(link.pairing).toBeUndefined();
		link.set("connected");
		expect((await post(a, NUMBER)).status).toBe(303);
		expect(link.pairing).toBeUndefined();
	});

	test("digits: country code first, 10 to 15 digits", () => {
		expect(pairingDigits("1 555 010-0100")).toBe(NUMBER);
		expect(pairingDigits(OTHER_FORM)).toBe(OTHER_FORM);
		expect(pairingDigits("05550100100")).toBeUndefined();
		expect(pairingDigits("12345")).toBeUndefined();
	});

	test("each typed number ends the current socket, so the adapter asks for its code on a fresh one", async () => {
		const device = await linkedDevice({ authDir: mkdtempSync(path.join(tmpdir(), "wa-auth-")), userName: "Clerk", logPrefix: "test" });
		const ended: unknown[] = [];
		Reflect.set(device.baileys, "_socket", { end: (e: unknown) => ended.push(e) });
		device.link.set("waiting-for-scan", "qr-data");
		device.link.requestPairingCode(NUMBER);
		device.link.requestPairingCode(OTHER_FORM); // another try: another fresh socket
		expect(ended.length).toBe(2);
		expect(device.link.pairing).toEqual({ phone: OTHER_FORM });
	});

	test("a socket replaced mid-pairing does not log in on the half-made credentials (401), and its code is dropped", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "wa-auth-"));
		const device = await linkedDevice({ authDir: dir, userName: "Clerk", logPrefix: "test" });
		const creds = Reflect.get(Reflect.get(Reflect.get(device.baileys, "_config"), "auth"), "state").creds;
		device.link.requestPairingCode(NUMBER);
		device.link.pairingCode("WXYZ5678");
		// What Baileys' requestPairingCode leaves: the number without a device id, and the code.
		creds.me = { id: `${NUMBER}@s.whatsapp.net`, name: "~" };
		creds.pairingCode = "WXYZ5678";
		const log = device.link.watchingLogger("chat");
		log.info("Connection closed (code=408, reconnect=true)");
		expect(creds.me).toBeUndefined();
		expect(creds.pairingCode).toBeUndefined();
		expect(device.link.pairing).toEqual({ phone: NUMBER }); // the number stays; the new socket asks again
		// After a successful pairing the restart keeps the real identity (device id), and so does a registered device.
		creds.me = { id: `${NUMBER}:12@s.whatsapp.net`, name: "~" };
		log.info("Restarting socket after QR auth handshake…");
		log.info("Connection closed (code=515, reconnect=true)");
		expect(creds.me?.id).toBe(`${NUMBER}:12@s.whatsapp.net`);
		creds.registered = true;
		creds.me = { id: `${NUMBER}@s.whatsapp.net`, name: "~" };
		log.info("Connection closed (code=428, reconnect=true)");
		expect(creds.me?.id).toBe(`${NUMBER}@s.whatsapp.net`);
	});

	test("a restart mid-pairing loads creds.json without the provisional identity, and saves that; a real one stays", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "wa-auth-"));
		const save = async (me: { id: string; name: string }) => {
			const d = await linkedDevice({ authDir: dir, userName: "Clerk", logPrefix: "test" });
			const auth = Reflect.get(Reflect.get(d.baileys, "_config"), "auth");
			auth.state.creds.me = me;
			auth.state.creds.pairingCode = "WXYZ5678";
			await auth.saveCreds(); // what the adapter does on Baileys' creds.update
		};
		const reload = async () => {
			const d = await linkedDevice({ authDir: dir, userName: "Clerk", logPrefix: "test" });
			return Reflect.get(Reflect.get(d.baileys, "_config"), "auth").state.creds;
		};
		const onDisk = () => JSON.parse(readFileSync(path.join(dir, "creds.json"), "utf8"));

		await save({ id: `${NUMBER}@s.whatsapp.net`, name: "~" });
		expect((await reload()).me).toBeUndefined();
		expect(onDisk().me).toBeUndefined();
		expect(onDisk().pairingCode).toBeUndefined();

		await save({ id: `${NUMBER}:12@s.whatsapp.net`, name: "Clerk" });
		expect((await reload()).me?.id).toBe(`${NUMBER}:12@s.whatsapp.net`);
		expect(onDisk().me.id).toBe(`${NUMBER}:12@s.whatsapp.net`);
	});
});

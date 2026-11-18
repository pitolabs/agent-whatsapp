// Pairing pages, one per linked device (e.g. /whatsapp, /whatsapp/sales). Each shows the link status and, while
// unpaired, two ways in: the QR to scan from that number's phone (WhatsApp > Settings > Linked devices > Link a
// device), or, for a phone without a camera (an emulator), a form that takes the number and shows the 8-character
// code WhatsApp gives for it (Link a device > Link with phone number instead). The pages must sit behind the host's
// login (the `middleware` given to pairingRoutes); the QR and the code are login credentials for the number, so
// neither reaches logs (nor does the number typed), and the page tells the browser not to cache them.
import { registerApiRoute } from "@mastra/core/server";
import type { Context, MiddlewareHandler } from "hono";
import QRCode from "qrcode";
import type { Link } from "./link.ts";

/** A page; `refresh` false for the number form, so typing is not cut off by a reload. */
const page = (
	title: string,
	body: string,
	refresh = true,
) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="10">' : ""}<title>${title} WhatsApp</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}img{width:100%;max-width:22rem;image-rendering:pixelated}small{color:#666}.code{font:700 2.4rem ui-monospace,monospace;letter-spacing:.15em}input{font-size:1rem;padding:.3rem}</style>
</head><body><h1>${title} · WhatsApp</h1>${body}${refresh ? "<p><small>Atualiza sozinha a cada 10 s.</small></p>" : ""}</body></html>`;

/** Digits of a phone number as WhatsApp's pairing code wants it (country code first, no +), or undefined. */
export function pairingDigits(typed: string): string | undefined {
	const digits = typed.replace(/\D/g, "");
	return /^[1-9]\d{9,14}$/.test(digits) ? digits : undefined;
}

const withDash = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/** The GET page. `phone` names whose phone pairs, e.g. "do número da loja". */
export function pairingPage(path: string, title: string, phone: string, link: Link) {
	return async (c: Context) => {
		c.header("Cache-Control", "no-store");
		c.header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'");
		const { status, qr, since: at } = link.state;
		const since = new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
		if (status === "connected") return c.html(page(title, `<p>✅ Conectado desde ${since}.</p>`));
		if (status === "logged-out") {
			return c.html(page(title, `<p>⚠️ Desconectado pelo WhatsApp em ${since}. Reinicie o container para gerar um QR novo.</p>`));
		}
		if (status !== "waiting-for-scan") return c.html(page(title, "<p>Conectando…</p>"));
		const steps = `No celular ${phone}: <b>WhatsApp › Configurações › Dispositivos conectados › Conectar dispositivo</b>`;
		// The number form has its own address, without the reload (?numero).
		if (c.req.query("numero") !== undefined) {
			return c.html(
				page(
					title,
					`<form method="post" action="${path}"><p>Digite o número ${phone}, com DDI e DDD (ex.: 55 51 9xxxx-xxxx). A página seguinte mostra um código de 8 letras.</p><p><input name="phone" inputmode="tel" autocomplete="off" autofocus required> <button>Pedir código</button></p></form><p><small><a href="${path}">Voltar</a></small></p>`,
					false,
				),
			);
		}
		const byNumber = (text: string) => `<p><a href="${path}?numero">${text}</a></p>`;
		if (link.pairing?.code) {
			return c.html(
				page(
					title,
					`<p>${steps} › <b>Conectar com número de telefone</b>, e digite:</p><p class="code">${withDash(link.pairing.code)}</p><p><small>O código muda a cada poucos minutos: digite o que estiver na tela agora.</small></p><hr>${byNumber("Número errado? Digite de novo (ou no outro formato, com ou sem o 9)")}`,
				),
			);
		}
		if (link.pairing) return c.html(page(title, `<p>Pedindo o código ao WhatsApp… (até meio minuto)</p>`));
		const img = qr ? `<img alt="QR" src="${await QRCode.toDataURL(qr, { margin: 2, width: 360 })}">` : "";
		return c.html(page(title, `<p>${steps}, e escaneie:</p>${img}<hr>${byNumber("<b>Sem câmera?</b> Conectar com o número de telefone")}`));
	};
}

/** The POST of the page's form: the number for a pairing code. Only from the page itself (same origin). */
export function pairingRequest(path: string, title: string, link: Link) {
	return async (c: Context) => {
		const site = c.req.header("Sec-Fetch-Site");
		if (site && site !== "same-origin") return c.text("forbidden", 403);
		const body = await c.req.parseBody();
		const digits = pairingDigits(String(body.phone ?? ""));
		if (!digits) return c.text("Número inválido: use DDI + DDD + número, só dígitos.", 400);
		if (link.state.status !== "waiting-for-scan") return c.redirect(path, 303);
		link.requestPairingCode(digits);
		console.info(`[pairing] ${title}: pairing code requested`);
		return c.redirect(path, 303);
	};
}

/**
 * The pairing page's two routes: GET (status, QR, code) and POST (the form). `middleware` is the host's login check:
 * the routes sit outside /api/*, so a server-wide guard rail on /api/* does not cover them.
 */
export function pairingRoutes(path: string, title: string, phone: string, link: Link, middleware: MiddlewareHandler) {
	return [
		registerApiRoute(path, { method: "GET", requiresAuth: false, middleware, handler: pairingPage(path, title, phone, link) }),
		registerApiRoute(path, { method: "POST", requiresAuth: false, middleware, handler: pairingRequest(path, title, link) }),
	];
}

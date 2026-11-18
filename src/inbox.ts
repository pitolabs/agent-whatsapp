// Files sent on WhatsApp, for archiving. The handler keeps the archivable attachments of the latest admitted turn's
// messages (per conversation, in ApprovalGate) and serves the same bytes to the model, so a PDF or photo is downloaded
// once.
import type { InboxFile } from "@pitolabs/agent-docs/mastra";
import type { Message } from "chat";

/** Files a person may send to archive: PDFs, images and office documents, up to 16 MB each. */
const ARCHIVABLE =
	/^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.ms-excel|vnd\.oasis\.opendocument\.[\w.]+)|image\/(jpeg|png|webp|heic))$/;
const MAX_FILE = 16 << 20;

export async function filesOf(message: Message): Promise<InboxFile[]> {
	const out: InboxFile[] = [];
	for (const att of message.attachments) {
		const mimeType = (att.mimeType ?? "").split(";")[0]?.trim() ?? "";
		if (!ARCHIVABLE.test(mimeType)) continue;
		const data = att.data ?? (await att.fetchData?.());
		if (!data) continue;
		const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : Uint8Array.from(new Uint8Array(data));
		if (bytes.byteLength > MAX_FILE) continue;
		// Already downloaded: Mastra reads attachments through fetchData (never `data`), so serve the same bytes and the
		// model reads the PDF or photo without a second download from WhatsApp.
		att.fetchData = async () => Buffer.from(bytes);
		out.push({
			name: att.name && att.name !== "image" && att.name !== "document" ? att.name : `arquivo.${mimeType.split("/")[1] ?? "bin"}`,
			mimeType,
			data: bytes,
		});
	}
	return out;
}

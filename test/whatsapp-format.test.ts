// WhatsAppConverter: the agents write Markdown, people read WhatsApp text. Constructs WhatsApp has no mark for
// (tables, nested lists) must still read as separate lines, not one run of glued cells
// ("PreçoFreteTotal*Item A*R$ 4.300R$ 130*R$ 4.430*…").
import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "chat";
import { WhatsAppConverter } from "../src/whatsapp.ts";

const render = (md: string) => new WhatsAppConverter().fromAst(parseMarkdown(md));

describe("WhatsAppConverter", () => {
	test("a table becomes one list line per row, each value named by its header", () => {
		const md = `| | Preço | Frete | Total |
|---|---|---|---|
| **Item A** | R$ 4.300 | R$ 130 | **R$ 4.430** |
| **Item B** | R$ 3.780 | | **R$ 3.910** |`;
		expect(render(md)).toBe(
			["- *Item A* — Preço: R$ 4.300 · Frete: R$ 130 · Total: *R$ 4.430*", "- *Item B* — Preço: R$ 3.780 · Total: *R$ 3.910*"].join("\n"),
		);
	});

	test("a nested list keeps its items on their own indented lines", () => {
		expect(render("- A\n  - 15/01\n  - 16/01\n- B")).toBe("- A\n   - 15/01\n   - 16/01\n- B");
	});

	test("an ordered list keeps its starting number", () => {
		expect(render("3. three\n4. four")).toBe("3. three\n4. four");
	});

	test("Markdown marks become WhatsApp's", () => {
		expect(render("**bold**, _italic_, ~~strike~~ and `code`")).toBe("*bold*, _italic_, ~strike~ and `code`");
	});
});

import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { badRequest } from "../errors.js";
import type { ExportPayload, ImportPayload, RawRecord } from "./common.js";

/*
 * XML format (version 1). Elements are omitted when the value is null/absent.
 *
 * <expenses version="1" exportedAt="2026-10-14T10:00:00.000Z">
 *   <categories>
 *     <category id="groceries" isCustom="false">
 *       <name>Élelmiszer</name><icon>shopping-cart</icon><color>#7c9a7e</color>
 *       <parentId>…</parentId><budget>80000</budget>
 *     </category>
 *   </categories>
 *   <transactions>
 *     <transaction id="…" source="manual">
 *       <date>2026-10-12T00:00:00.000Z</date><amount>-4785</amount><currency>HUF</currency>
 *       <merchant>SPAR</merchant><categoryId>groceries</categoryId><note>…</note><externalId>…</externalId>
 *       <items><item><name>Tej</name><quantity>2</quantity><unitPrice>389</unitPrice><total>778</total>
 *         <product>tej</product><brand>Mizo</brand><packSize>1</packSize><packUnit>l</packUnit></item></items>
 *     </transaction>
 *   </transactions>
 * </expenses>
 */

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressBooleanAttributes: false,
});

const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);

export function exportXml(p: ExportPayload, exportedAt = new Date().toISOString()): string {
  const doc = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    expenses: {
      "@_version": "1",
      "@_exportedAt": exportedAt,
      categories: {
        category: p.categories.map((c) => ({
          "@_id": c.id,
          "@_isCustom": String(c.isCustom),
          name: c.name,
          icon: c.icon,
          color: c.color,
          parentId: opt(c.parentId),
          budget: opt(c.budget),
        })),
      },
      transactions: {
        transaction: p.transactions.map((t) => ({
          "@_id": t.id,
          "@_source": t.source,
          date: t.date,
          amount: t.amount,
          currency: t.currency,
          merchant: t.merchant,
          categoryId: opt(t.categoryId),
          note: opt(t.note),
          externalId: opt(t.externalId),
          items: t.items ? { item: t.items.map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v != null))) } : undefined,
        })),
      },
    },
  };
  return builder.build(doc) as string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep everything as strings; zod coerces numbers
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ["category", "transaction", "item"].includes(name),
});

type Node = Record<string, unknown>;

/** Strips "@_" from attributes and drops whitespace-only text nodes left by pretty-printing. */
function flatten(n: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === "#text") continue;
    out[k.startsWith("@_") ? k.slice(2) : k] = v;
  }
  return out;
}

export function parseXml(text: string): ImportPayload {
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw badRequest(`Invalid XML at line ${valid.err.line}: ${valid.err.msg}`);
  const doc = parser.parse(text) as Node;
  const root = doc.expenses as Node | undefined;
  if (!root || typeof root !== "object") throw badRequest("XML root element must be <expenses>");
  const cats = ((root.categories as Node | undefined)?.category ?? []) as Node[];
  const txs = ((root.transactions as Node | undefined)?.transaction ?? []) as Node[];
  const categories: RawRecord[] = cats.map((c, i) => ({ where: `category #${i + 1}`, data: flatten(c) }));
  const transactions: RawRecord[] = txs.map((t, i) => {
    const data = flatten(t);
    const items = data.items as Node | string | undefined;
    if (items && typeof items === "object") data.items = ((items.item ?? []) as Node[]).map(flatten);
    else if (typeof items === "string") data.items = items.trim() === "" ? [] : items;
    return { where: `transaction #${i + 1}${data.id ? ` (${String(data.id)})` : ""}`, data };
  });
  return { categories, transactions };
}

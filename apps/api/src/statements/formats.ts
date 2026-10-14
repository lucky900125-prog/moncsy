import { XMLParser } from "fast-xml-parser";
import type { StatementTx } from "@et/shared";
import { badRequest } from "../errors.js";
import { categorize } from "../revolut/categorize.js";
import { rowExternalId } from "./tabular.js";
import { parseAmount, parseStatementDate } from "./values.js";

export interface FormatResult {
  currency: string | null;
  transactions: StatementTx[];
  ignored: number;
  errors: string[];
}

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return str((v as Record<string, unknown>)["#text"] ?? "");
  return String(v).trim();
};

function buildTx(
  fields: { date: string; amount: number; currency: string; counterparty: string; description: string; ref: string },
  seen: Map<string, number>,
): StatementTx {
  const { date, amount, currency, counterparty, description, ref } = fields;
  const merchant = (counterparty || description || "Ismeretlen").slice(0, 200);
  const tx: StatementTx = {
    externalId: ref
      ? rowExternalId(["ref", ref, date.slice(0, 10), amount.toFixed(2)], seen)
      : rowExternalId([date, amount.toFixed(2), currency, counterparty, description], seen),
    date,
    amount: Math.round(amount * 100) / 100,
    currency,
    merchant,
    categoryId: categorize(`${counterparty} ${description}`, amount),
    source: "import",
  };
  if (counterparty && description && description !== counterparty) tx.note = description.slice(0, 2000);
  return tx;
}

/**
 * ISO 20022 cash-management statements: camt.053 (statement), camt.052 (intraday report), camt.054 (notification).
 * The XML statement format most European banks offer next to PDF.
 */
export function parseCamt(xml: string, timeZone: string): FormatResult {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const root = doc?.Document;
  const reports = [
    ...arr(root?.BkToCstmrStmt?.Stmt),
    ...arr(root?.BkToCstmrAcctRpt?.Rpt),
    ...arr(root?.BkToCstmrDbtCdtNtfctn?.Ntfctn),
  ] as Record<string, any>[];
  if (!reports.length) throw badRequest("Not an ISO 20022 camt.052/053/054 statement (no Stmt, Rpt or Ntfctn element)");
  const res: FormatResult = { currency: null, transactions: [], ignored: 0, errors: [] };
  const seen = new Map<string, number>();
  for (const rep of reports) {
    const accountCcy = str(rep.Acct?.Ccy) || null;
    res.currency ??= accountCcy;
    arr(rep.Ntry).forEach((e: Record<string, any>, i: number) => {
      const where = `Entry ${i + 1}`;
      try {
        const status = str(e.Sts?.Cd ?? e.Sts);
        if (status && status !== "BOOK") {
          res.ignored++;
          return;
        }
        const amt = parseAmount(str(e.Amt), ".");
        if (amt === null) throw new Error("no amount");
        const debit = str(e.CdtDbtInd) === "DBIT";
        const amount = debit ? -Math.abs(amt) : Math.abs(amt);
        const currency = str(e.Amt?.["@_Ccy"]) || accountCcy;
        if (!currency) throw new Error("no currency");
        const dateRaw = str(e.BookgDt?.DtTm) || str(e.BookgDt?.Dt) || str(e.ValDt?.DtTm) || str(e.ValDt?.Dt);
        if (!dateRaw) throw new Error("no booking or value date");
        const tx = arr(e.NtryDtls).flatMap((d: Record<string, any>) => arr(d.TxDtls))[0] as Record<string, any> | undefined;
        const party = debit ? tx?.RltdPties?.Cdtr : tx?.RltdPties?.Dbtr;
        const counterparty = str(party?.Nm ?? party?.Pty?.Nm);
        const description = [...arr(tx?.RmtInf?.Ustrd).map(str), str(e.AddtlNtryInf)].filter(Boolean).join(" ");
        const ref = str(e.AcctSvcrRef) || str(e.NtryRef) || str(tx?.Refs?.AcctSvcrRef) || str(tx?.Refs?.EndToEndId).replace(/^NOTPROVIDED$/, "");
        res.transactions.push(
          buildTx({ date: parseStatementDate(dateRaw.slice(0, 19).replace("T", " "), "ymd", timeZone), amount, currency, counterparty, description, ref }, seen),
        );
      } catch (err) {
        res.errors.push(`${where}: ${(err as Error).message}`);
      }
    });
  }
  return res;
}

/** OFX / QFX (Money, Quicken). Version 1 is SGML with unclosed tags, version 2 is XML; both are read tag by tag. */
export function parseOfx(text: string, timeZone: string): FormatResult {
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"))?.[1]?.trim() ?? "";
  const currency = tag(text, "CURDEF") || null;
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((m) => m[1]!);
  if (!blocks.length) throw badRequest("No <STMTTRN> transactions found in the OFX file");
  const res: FormatResult = { currency, transactions: [], ignored: 0, errors: [] };
  const seen = new Map<string, number>();
  blocks.forEach((b, i) => {
    try {
      // OFX allows a comma as the decimal mark and no thousands separator, so the last mark in the value is the decimal one.
      const rawAmount = tag(b, "TRNAMT");
      const amount = parseAmount(rawAmount, rawAmount.lastIndexOf(",") > rawAmount.lastIndexOf(".") ? "," : ".");
      if (amount === null) throw new Error("no TRNAMT");
      // CURSYM in <CURRENCY> is the currency of the amount; in <ORIGCURRENCY> the amount is already in CURDEF.
      const ccy = b.match(/<CURRENCY>(?:(?!<\/?(?:ORIG)?CURRENCY>)[\s\S])*?<CURSYM>\s*([A-Za-z]{3})/i)?.[1]?.toUpperCase() || currency;
      if (!ccy) throw new Error("no currency (CURDEF)");
      const posted = tag(b, "DTPOSTED") || tag(b, "DTUSER");
      if (!posted) throw new Error("no DTPOSTED");
      res.transactions.push(
        buildTx(
          {
            date: parseStatementDate(posted.slice(0, 14), "ymd", timeZone),
            amount,
            currency: ccy,
            counterparty: tag(b, "NAME") || tag(b, "PAYEE"),
            description: tag(b, "MEMO"),
            ref: tag(b, "FITID"),
          },
          seen,
        ),
      );
    } catch (e) {
      res.errors.push(`Transaction ${i + 1}: ${(e as Error).message}`);
    }
  });
  return res;
}

/**
 * SWIFT MT940, which Hungarian and German banks offer for business accounts.
 * :60F: carries the currency, each :61: is a booking and the :86: after it its free-text details.
 */
export function parseMt940(text: string, timeZone: string): FormatResult {
  const fields = [...text.replace(/\r/g, "").matchAll(/^:(\d{2}[A-Z]?):([\s\S]*?)(?=^:\d{2}[A-Z]?:|^-\}?\s*$|(?![\s\S]))/gm)].map((m) => ({
    tag: m[1]!,
    value: m[2]!.trim(),
  }));
  if (!fields.some((f) => f.tag === "61")) throw badRequest("No :61: booking lines found in the MT940 file");
  const res: FormatResult = { currency: null, transactions: [], ignored: 0, errors: [] };
  const seen = new Map<string, number>();
  let currency: string | null = null;
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.tag === "60F" || f.tag === "60M") {
      currency = f.value.slice(7, 10) || currency;
      res.currency ??= currency;
      continue;
    }
    if (f.tag !== "61") continue;
    n++;
    try {
      const m = f.value.match(/^(\d{2})(\d{2})(\d{2})(\d{4})?(R?[CD])[A-Z]?(\d+,\d*)([A-Z]\w{3})?([^\n/]*)(?:\/\/([^\n]*))?/);
      if (!m) throw new Error(`unreadable :61: line "${f.value.split("\n")[0]}"`);
      const [, yy, mm, dd, , mark, amt, , custRef, bankRef] = m;
      const value = parseAmount(amt!, ",")!;
      // RC (reversal of credit) moves money out, RD (reversal of debit) moves it back in.
      const out = mark === "D" || mark === "RC";
      const next = fields[i + 1];
      const details = next?.tag === "86" ? next.value.replace(/\n/g, "").replace(/\?\d{2}/g, " ").replace(/\s+/g, " ").trim() : "";
      const name = next?.tag === "86" ? [...next.value.replace(/\n/g, "").matchAll(/\?3[23]([^?]*)/g)].map((x) => x[1]).join("").trim() : "";
      if (!currency) throw new Error("no :60F: opening balance with the currency before this booking");
      res.transactions.push(
        buildTx(
          {
            date: parseStatementDate(`20${yy}-${mm}-${dd}`, "ymd", timeZone),
            amount: out ? -value : value,
            currency,
            counterparty: name,
            description: details,
            ref: (bankRef || (custRef && custRef !== "NONREF" ? custRef : "") || "").trim(),
          },
          seen,
        ),
      );
    } catch (e) {
      res.errors.push(`Booking ${n}: ${(e as Error).message}`);
    }
  }
  return res;
}

import { describe, expect, it } from "vitest";
import { parseStatementCsv, revolutLayout } from "../src/revolut/csv.js";
import { multipart, testApp } from "./helpers.js";

const TZ = "Europe/Budapest";

// Invented rows. The Hungarian header is the one a real export had (2026-10-16); the Czech one is from
// https://git.vitexsoftware.com/MultiFlexi/AbraFlexi-Revolut (README, "Czech Format").
const HU = `Típus,Termék,Kezdés dátuma,Teljesítés dátuma,Leírás,Összeg,Díj,Pénznem,State,Egyenleg
CARD_PAYMENT,Current,2026-10-01 08:15:42,2026-10-02 09:01:10,Spar,-4785.00,0.00,HUF,COMPLETED,120215.00
CARD_PAYMENT,Current,2026-10-06 20:00:00,,Netflix.com,-4.99,0.00,EUR,PENDING,
`;
const CS = `Typ,Produkt,Datum zahájení,Datum dokončení,Popis,Částka,Poplatek,Měna,State,Zůstatek
Platba kartou,Aktuální,2026-10-01 08:15:42,2026-10-01 08:15:43,Albert,-163.68,0.00,CZK,DOKONČENO,170.09
`;
/** A language with no header words here: only Revolut's column order identifies it. Day-first dates, decimal commas. */
const UNKNOWN = `K1;K2;K3;K4;K5;K6;K7;K8;State;K10
CARD_PAYMENT;Current;01.10.2026 08:15:42;02.10.2026 09:01:10;Spar;-1.234,50;0,50;EUR;ZZZ;98,10
CARD_PAYMENT;Current;06.10.2026 20:00:00;;Netflix.com;-4,99;0,00;EUR;ZZZ;
`;

describe("Revolut statements in other languages", () => {
  it("reads the Hungarian header", () => {
    const { rows, errors } = parseStatementCsv(HU, TZ);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ product: "Current", startedDate: "2026-10-01T06:15:42.000Z", description: "Spar", amount: -4785, currency: "HUF", state: "COMPLETED" });
  });

  it("reads the Czech header and its translated state and type", () => {
    const { rows, errors } = parseStatementCsv(CS, TZ);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ type: "CARD_PAYMENT", description: "Albert", amount: -163.68, currency: "CZK", state: "COMPLETED" });
  });

  it("reads any other language by Revolut's column order, with day-first dates and decimal commas", () => {
    const { rows, errors } = parseStatementCsv(UNKNOWN, TZ);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ startedDate: "2026-10-01T06:15:42.000Z", amount: -1234.5, fee: 0.5, currency: "EUR", balance: 98.1, state: "COMPLETED" });
    // A state word it does not know counts as completed only with a completion date.
    expect(rows[1]).toMatchObject({ completedDate: null, state: "ZZZ" });
  });

  it("does not take another bank's ten columns for a Revolut statement", () => {
    const header = ["Dátum", "Könyvelés", "Partner", "Számla", "Közlemény", "Összeg", "Egyenleg", "Pénznem", "Típus", "Azonosító"];
    expect(revolutLayout(header, ["2026.10.01", "2026.10.01", "Spar", "1177", "x", "-4785", "1000", "HUF", "kártya", "1"])).toBeNull();
    expect(() => parseStatementCsv(`${header.join(",")}\n2026.10.01,2026.10.01,Spar,1177,x,-4785,1000,HUF,kártya,1\n`, TZ)).toThrow(/Not a Revolut statement/);
  });

  it("imports them and recognises them in the statement preview", async () => {
    const app = await testApp();
    for (const [name, csv, imported] of [["hu.csv", HU, 1], ["cs.csv", CS, 1], ["other.csv", UNKNOWN, 1]] as const) {
      const r = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart(name, "text/csv", csv) });
      expect(r.json(), name).toMatchObject({ imported, errors: [] });
      const preview = await app.inject({ method: "POST", url: "/api/statements/parse", ...multipart(name, "text/csv", csv) });
      expect(preview.json().format, name).toBe("revolut");
    }
    await app.close();
  });
});

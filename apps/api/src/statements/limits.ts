// How much of a bank statement is read at once. Text formats (CSV, OFX, MT940, CAMT) are parsed on the main thread,
// so their size is what every other request waits for: 2 MB of CSV takes about 0.6 s here, 9 MB took seconds.
import { HttpError } from "../errors.js";

/** The most transactions a statement may hold, in a preview and in one import. */
export const MAX_STATEMENT_ROWS = 20_000;
/** 20 000 CSV rows are about 2 MB; CAMT XML spends several times as many bytes on a transaction. */
export const MAX_TEXT_STATEMENT_BYTES = 4 * 1024 * 1024;

export function assertTextStatementSize(data: Buffer): void {
  if (data.length > MAX_TEXT_STATEMENT_BYTES) {
    throw new HttpError(
      413,
      `The statement is ${(data.length / 1024 / 1024).toFixed(1)} MB; text statements (CSV, OFX, MT940, CAMT) of more than ` +
        `${MAX_TEXT_STATEMENT_BYTES / 1024 / 1024} MB are not read. Export a shorter period`,
    );
  }
}

/** rows counts every row read: transactions, rows skipped on purpose and unreadable ones. */
export function assertStatementRows(rows: number): void {
  if (rows > MAX_STATEMENT_ROWS) {
    throw new HttpError(413, `The statement has ${rows} rows; more than ${MAX_STATEMENT_ROWS} are not read at once. Export a shorter period`);
  }
}

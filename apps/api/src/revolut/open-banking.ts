import type { RevolutStatus } from "@et/shared";
import { HttpError } from "../errors.js";
import type { RevolutProvider } from "./types.js";

export const OPEN_BANKING_MESSAGE =
  "Personal Revolut accounts cannot be read directly: Revolut's Open Banking (PSD2 AIS) API is only available to " +
  "licensed Account Information Service Providers (AISPs). Connect through a licensed aggregator such as " +
  "GoCardless Bank Account Data or Enable Banking, or import the Revolut app's account statement export via " +
  "POST /api/revolut/import-statement.";

/**
 * TODO: implement via an aggregator. Sketch for GoCardless Bank Account Data:
 *   1. POST /api/v2/token/new/ with secret_id/secret_key -> access token
 *   2. POST /api/v2/requisitions/ with institution_id "REVOLUT_REVOGB21" and a redirect URL;
 *      the user consents in the browser (90-180 day consent)
 *   3. GET /api/v2/accounts/{id}/transactions/ and map booked transactions to Transaction
 *      (externalId = transactionId / internalTransactionId).
 * Enable Banking follows the same consent -> session -> accounts -> transactions flow.
 */
export class OpenBankingRevolutProvider implements RevolutProvider {
  readonly mode = "open-banking" as const;

  async status(): Promise<RevolutStatus> {
    return { connected: false, mode: this.mode, lastSyncAt: null, accounts: [] };
  }

  async sync(): Promise<{ imported: number; skipped: number }> {
    throw new HttpError(501, OPEN_BANKING_MESSAGE);
  }
}

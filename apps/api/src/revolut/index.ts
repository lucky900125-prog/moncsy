import type { AppConfig } from "../config.js";
import type { Repository } from "../repository.js";
import { BusinessApiRevolutProvider } from "./business-api.js";
import { CsvRevolutProvider } from "./csv.js";
import { OpenBankingRevolutProvider } from "./open-banking.js";
import type { RevolutProvider } from "./types.js";

export type { RevolutProvider } from "./types.js";
export { importStatement } from "./csv.js";

export function createRevolutProvider(cfg: AppConfig["revolut"], repo: Repository): RevolutProvider {
  switch (cfg.mode) {
    case "business-api":
      return new BusinessApiRevolutProvider(repo, cfg.businessToken, cfg.env);
    case "open-banking":
      return new OpenBankingRevolutProvider();
    case "csv":
      return new CsvRevolutProvider(repo);
  }
}

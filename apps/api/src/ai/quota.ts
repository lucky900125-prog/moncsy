import { HttpError } from "../errors.js";
import type { AIProvider, ChatMessage, CompleteOptions } from "./types.js";

/**
 * Counts every call to an AI provider and refuses the ones over dailyLimit with 429, so a leaked token or a stuck
 * client cannot run up the providers' bills. Each call is counted before it is made, since a failed one may cost too.
 * The count lives in memory: a restart starts the day again, and each provider's own spending cap is the hard limit.
 * One count covers every provider and model, and with one API token for the whole server, the limit is that token's.
 */
export class DailyQuota {
  private day = "";
  private used = 0;

  constructor(private readonly dailyLimit: number) {}

  take(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.dailyLimit) {
      throw new HttpError(429, `The AI limit of ${this.dailyLimit} calls a day (AI_DAILY_LIMIT) is used up; it starts again at 00:00 UTC`);
    }
    this.used++;
  }
}

export class DailyLimitedProvider implements AIProvider {
  constructor(
    private readonly inner: AIProvider,
    private readonly quota: DailyQuota,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string> {
    this.quota.take();
    return this.inner.complete(messages, opts);
  }

  vision(imageBase64: string, mime: string, prompt: string, opts?: CompleteOptions): Promise<string> {
    this.quota.take();
    return this.inner.vision(imageBase64, mime, prompt, opts);
  }
}

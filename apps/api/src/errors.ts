export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HttpError";
  }
}

/** The message followed by each cause's message, as one line ("a: b: c"). */
export function messageWithCauses(e: Error): string {
  let out = e.message;
  for (let c = e.cause; c instanceof Error; c = c.cause) out += `: ${c.message}`;
  return out;
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg: string) => new HttpError(404, msg);

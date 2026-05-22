import type { ErrorEnvelope, FailEnvelope } from "./types.js";

export class FcApiError extends Error {
  readonly statusCode: number;
  readonly envelope: FailEnvelope | ErrorEnvelope | undefined;
  readonly response: Response;

  constructor(message: string, response: Response, envelope?: FailEnvelope | ErrorEnvelope) {
    super(message);
    this.name = "FcApiError";
    this.statusCode = response.status;
    this.response = response;
    this.envelope = envelope;
  }
}

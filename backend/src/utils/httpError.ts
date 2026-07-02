/**
 * Typed HTTP error. Throw these from routes/services to control the status code
 * and message returned to the client; the error middleware renders them as JSON.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, HttpError);
  }

  static badRequest(message = 'Bad Request', details?: unknown) {
    return new HttpError(400, message, details);
  }
  static notFound(message = 'Not Found') {
    return new HttpError(404, message);
  }
  static internal(message = 'Internal Server Error') {
    return new HttpError(500, message);
  }
}

export default HttpError;

/**
 * Every error response has the same shape:
 *   { "error": { "code": "snake_case_code", "message": "Human-readable text", "details": [...]? } }
 * Clients branch on `code`; `message` is for people; `details` lists field problems for 400s.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (code, message) => new ApiError(401, code, message);
export const forbidden = (code, message) => new ApiError(403, code, message);
export const notFound = (code, message) => new ApiError(404, code, message);
export const conflict = (code, message) => new ApiError(409, code, message);

export function sendError(res, error) {
  const body = { code: error.code, message: error.message };
  if (error.details) body.details = error.details;
  res.status(error.status).json({ error: body });
}

export function notFoundHandler(req, res) {
  sendError(res, notFound('not_found', 'No such endpoint'));
}

/**
 * Final Express error handler. Never echoes request bodies, cookies or SQL parameters.
 * For unexpected errors only the error class, message and stack are logged. PostgreSQL error
 * messages name the constraint but not the values (those are in `detail`, which is not logged).
 */
export function errorHandler(error, req, res, _next) {
  if (error instanceof ApiError) return sendError(res, error);

  if (error?.type === 'entity.parse.failed') {
    return sendError(res, badRequest('invalid_json', 'Request body is not valid JSON'));
  }
  if (error?.type === 'entity.too.large') {
    return sendError(res, new ApiError(413, 'payload_too_large', 'Request body is too large'));
  }

  console.error(
    `[api] unhandled ${error?.name ?? 'error'} on ${req.method} ${req.path}:`,
    error?.stack ?? error?.message,
  );
  return sendError(res, new ApiError(500, 'internal_error', 'Something went wrong'));
}

export class HttpError extends Error {
  constructor(status, message, code = 'UNKNOWN_ERROR', payload = null) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.payload = payload;
    /** @type {string|undefined} */
    this.field = undefined;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Bad Request', code = 'BAD_REQUEST') {
    super(400, message, code);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(401, message, code);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(403, message, code);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not Found', code = 'NOT_FOUND') {
    super(404, message, code);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message = 'Payload Too Large', code = 'PAYLOAD_TOO_LARGE') {
    super(413, message, code);
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(message = 'Unsupported Media Type', code = 'UNSUPPORTED_MEDIA_TYPE') {
    super(415, message, code);
  }
}

export class BadGatewayError extends HttpError {
  constructor(message = 'Bad Gateway', code = 'BAD_GATEWAY') {
    super(502, message, code);
  }
}

export class GatewayTimeoutError extends HttpError {
  constructor(message = 'Gateway Timeout', code = 'GATEWAY_TIMEOUT') {
    super(504, message, code);
  }
}

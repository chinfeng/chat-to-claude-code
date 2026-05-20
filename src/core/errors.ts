/** Anthropic-format error response helpers. */

export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export function makeAnthropicError(
  errorType: string,
  message: string,
  status: number,
): { json: AnthropicError; status: number } {
  return {
    json: { type: "error", error: { type: errorType, message } },
    status,
  };
}

export function invalidRequestError(message: string) {
  return makeAnthropicError("invalid_request_error", message, 400);
}

export function authenticationError(message = "Invalid API key.") {
  return makeAnthropicError("authentication_error", message, 401);
}

export function notFoundError(message = "Not found.") {
  return makeAnthropicError("not_found_error", message, 404);
}

export function serverError(message: string) {
  return makeAnthropicError("api_error", message, 500);
}

export function upstreamError(message: string, status: number) {
  return makeAnthropicError("api_error", `Upstream error: ${message}`, status);
}

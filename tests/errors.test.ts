import { describe, it, expect } from "bun:test";
import { invalidRequestError, authenticationError, notFoundError, serverError, upstreamError } from "../src/core/errors.js";

describe("error helpers", () => {
  it("invalidRequestError returns 400", () => {
    const { json, status } = invalidRequestError("bad input");
    expect(status).toBe(400);
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toBe("bad input");
  });

  it("authenticationError returns 401", () => {
    const { json, status } = authenticationError();
    expect(status).toBe(401);
    expect(json.error.type).toBe("authentication_error");
  });

  it("notFoundError returns 404", () => {
    const { json, status } = notFoundError("missing");
    expect(status).toBe(404);
    expect(json.error.type).toBe("not_found_error");
  });

  it("serverError returns 500", () => {
    const { json, status } = serverError("boom");
    expect(status).toBe(500);
    expect(json.error.type).toBe("api_error");
  });

  it("upstreamError returns upstream status", () => {
    const { json, status } = upstreamError("timeout", 504);
    expect(status).toBe(504);
    expect(json.error.message).toContain("Upstream error");
  });
});

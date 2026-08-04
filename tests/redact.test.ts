import { describe, expect, it } from "vitest";
import { redactJson, redactText } from "../src/security/redact.js";

describe("secret redaction", () => {
  it("redacts assignments, JWTs, and private keys", () => {
    const result = redactText(
      "api_key=super-secret eyJhbGciOiJub25lIn0.payload-data-long.signature-data-long\n" +
        "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
    );

    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain("super-secret");
    expect(result.value).not.toContain("eyJhbGci");
    expect(result.value).not.toContain("BEGIN PRIVATE KEY");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["secret assignment", "JWT", "private key"]),
    );
  });

  it("redacts sensitive JSON keys recursively", () => {
    const result = redactJson({
      command: "npm test",
      credentials: {
        password: "do-not-store",
      },
    });

    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      command: "npm test",
      credentials: {
        password: "[REDACTED]",
      },
    });
  });
});

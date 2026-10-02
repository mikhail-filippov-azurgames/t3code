import { describe, expect, it, vi } from "@effect/vitest";

import {
  applyAuthorTextPolicy,
  applyDerivedTextPolicy,
  detectSecrets,
  projectDerivedText,
  SECRET_REDACTION_LABEL,
} from "./SecretTextPolicy.ts";

const providerToken = `ghp_${"A".repeat(32)}`;

describe("SecretTextPolicy", () => {
  it("detects secret-like values without returning their contents", () => {
    const detection = detectSecrets(`Credential: ${providerToken}`);

    expect(detection).toMatchObject({ _tag: "SecretsFound", count: 1 });
    expect(JSON.stringify(detection).includes(providerToken)).toBe(false);
  });

  it("rejects authored text when it contains a detected secret", () => {
    const result = applyAuthorTextPolicy("message", `Use ${providerToken} for access.`);

    expect(
      result._tag === "Rejected" &&
        result.error._tag === "SecretDetected" &&
        result.error.field === "message",
    ).toBe(true);
  });

  it("accepts clean authored text unchanged", () => {
    const input = "Please read the README and write a short technical summary.";

    expect(applyAuthorTextPolicy("prompt", input)).toEqual({ _tag: "Accepted", text: input });
  });

  it("identifies rejected free-text handoff values", () => {
    const result = applyAuthorTextPolicy("handoff", `Use ${providerToken} for access.`);

    expect(result).toEqual({
      _tag: "Rejected",
      error: { _tag: "SecretDetected", field: "handoff" },
    });
    expect(JSON.stringify(result)).not.toContain(providerToken);
  });

  it("redacts detected secrets in derived text", () => {
    const input = `Provider token: ${providerToken}`;
    const result = applyDerivedTextPolicy("summary", input);

    expect(
      result._tag === "Redacted" &&
        result.text === `Provider token: ${SECRET_REDACTION_LABEL}` &&
        result.redactedCount === 1,
    ).toBe(true);
  });

  it("leaves clean derived text byte-for-byte unchanged", () => {
    const input = "Wake summary:\r\nГотово; прочитаны docs/api-key.md и config.ts.\n";
    const result = applyDerivedTextPolicy("wake", input);

    expect(result).toEqual({ _tag: "Unchanged", text: input });
    expect(projectDerivedText("wake", input)).toBe(input);
    if (result._tag === "Unchanged") {
      expect(Buffer.from(result.text).equals(Buffer.from(input))).toBe(true);
    }
  });

  it("fails closed when the derived-text check throws", () => {
    const secret = `output ${providerToken}`;
    const brokenPolicy: typeof applyDerivedTextPolicy = () => {
      throw new Error("injected policy failure");
    };

    const projected = projectDerivedText("read", secret, brokenPolicy);

    expect(projected).toBe(SECRET_REDACTION_LABEL);
    expect(projected).not.toContain(providerToken);
  });

  it("does not include a rejected secret in its result or logs", () => {
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      const result = applyAuthorTextPolicy("title", `Incident ${providerToken}`);

      expect(result._tag === "Rejected").toBe(true);
      expect(JSON.stringify(result).includes(providerToken)).toBe(false);
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not flag ordinary code, paths, placeholders, or technical documentation", () => {
    const input = String.raw`const apiKey = process.env.API_KEY;
const token = makeToken();
const accessToken = "generateAccessTokenNow";
const configPath = "C:\Users\demo\.ssh\id_rsa";
// Docs use API_KEY=your-api-key-here and Authorization: Bearer <token>.
// A JWT documentation placeholder is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature.
// Example database URL: https://username:password@example.test/app.
Read the permission configuration, then write a summary of the security policy.`;

    expect(applyAuthorTextPolicy("prompt", input)).toEqual({ _tag: "Accepted", text: input });
    expect(applyDerivedTextPolicy("read", input)).toEqual({ _tag: "Unchanged", text: input });
  });

  it("detects common structured credential formats with the shared rules", () => {
    const input = [
      "API_KEY=Ab1!Cd2@Ef3#Gh4$",
      "Authorization: Bearer A9bC8dE7fG6hJ5kL",
      "postgres://dbuser:P%40ssW0rd-long.Random9@db.example:5432/app",
      "Cookie: session=Q9wE2rT7yU4iO6pA1sD3; theme=dark",
      "-----BEGIN PRIVATE KEY-----\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/ab\nzyxwvutsrqponmlkjihgfedcba9876543210+/AB\n-----END PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkLTEyMzQ1Njc4OTAiLCJleHAiOjE3MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyz1234567890",
    ].join("\n");

    const detection = detectSecrets(input);

    expect(
      detection._tag === "SecretsFound" &&
        detection.count === 6 &&
        [
          "authorization",
          "cookie",
          "credential-url",
          "jwt",
          "private-key",
          "secret-assignment",
        ].every((kind) => detection.kinds.includes(kind as (typeof detection.kinds)[number])),
    ).toBe(true);
  });
});

function expectSecretPair(secret: string, clean: string): void {
  expect(detectSecrets(secret)).toMatchObject({ _tag: "SecretsFound", count: 1 });
  expect(detectSecrets(clean)).toEqual({ _tag: "Clean", count: 0, kinds: [] });
  expect(applyAuthorTextPolicy("prompt", clean)).toEqual({ _tag: "Accepted", text: clean });
  expect(applyDerivedTextPolicy("read", clean)).toEqual({ _tag: "Unchanged", text: clean });
}

describe("SecretTextPolicy regression pairs", () => {
  it("checks generic sk tokens for credential-like values", () => {
    expectSecretPair("sk-7f3a9c4e5b6d0789QwErTyUiOp", "disk-sk-activity-monitor-v2");
  });

  it("keeps placeholder passwords clean and detects escaped quoted values", () => {
    expectSecretPair('password="ab\\"cdEfGhIjKlMnOpQrStUvWx"', "password=changeme123");
  });

  it("keeps generated camel-case identifiers clean", () => {
    expectSecretPair(
      'const accessToken = "Ab1!Cd2@Ef3#Gh4$";',
      'const accessToken = "generateAccessToken2Now";',
    );
  });

  it("detects API keys with spaces in their names", () => {
    expectSecretPair('api key = "7f3a9c4e5b6d0789QwErTyUiOp"', "api key = process.env.API_KEY");
  });

  it("detects values assigned to the bare key name", () => {
    expectSecretPair("key=7f3a9c4e5b6d0789QwErTyUiOp", "key=makeKey()");
  });

  it("detects values assigned to the bare pwd name", () => {
    expectSecretPair("pwd=7f3a9c4e5b6d0789QwErTyUiOp", "pwd=changeme123");
  });

  it("detects values assigned to the bare pass name", () => {
    expectSecretPair("pass=7f3a9c4e5b6d0789QwErTyUiOp", "pass=changeme123");
  });

  it("detects JWTs with an empty signature segment", () => {
    expectSecretPair(
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    );
  });

  it("detects URL passwords containing at signs", () => {
    expectSecretPair(
      "postgres://admin:ab@CD9fGh2jKl4mN@db:5432/app",
      "https://username:password@example.test/app.",
    );
  });

  it("detects Slack xoxo and xoxe tokens while leaving placeholders clean", () => {
    expectSecretPair("xoxo-123456789012-abcdefghijklmnop", "xoxo-<token>");
    expectSecretPair("xoxe-123456789012-abcdefghijklmnop", "xoxe-<token>");
  });

  it("detects Stripe restricted keys", () => {
    expectSecretPair("rk_live_51H8xYzAbCdEfGhIjKlMnOpQr", "rk_live_<key>");
  });

  it("detects AWS key IDs only when surrounding text supplies context", () => {
    const awsKeyId = "AKIA1234567890ABCDEF";

    expectSecretPair("key=" + awsKeyId, awsKeyId);
    expectSecretPair("AWS_ACCESS_KEY_ID=" + awsKeyId, awsKeyId);
    expectSecretPair("https://example.test/?AWS_ACCESS_KEY_ID=" + awsKeyId, awsKeyId);
  });

  it("uses capture indices when a value also appears in its key", () => {
    const value = "7f3a9c4e5b6d0789QwErTyUiOp";
    const secret = value + "key=" + value;

    expectSecretPair(secret, "key=makeKey()");
    expect(applyDerivedTextPolicy("read", secret)).toEqual({
      _tag: "Redacted",
      text: value + "key=" + SECRET_REDACTION_LABEL,
      redactedCount: 1,
    });
  });
});

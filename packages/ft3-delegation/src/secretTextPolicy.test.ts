import { describe, expect, it, vi } from "@effect/vitest";

import {
  applyAuthorTextPolicy,
  applyDerivedTextPolicy,
  detectSecrets,
  projectDerivedText,
  SECRET_REDACTION_LABEL,
} from "./secretTextPolicy.ts";

const providerToken = `ghp_${"A".repeat(32)}`;
const fakeValue = ["7f3a9c4e5b6d0789", "QwErTyUiOp"].join("");
const fakeSession = ["Q9wE2rT7yU4", "iO6pA1sD3"].join("");
const fakeComplex = ["Ab1!Cd", "2@Ef3#Gh4$"].join("");
const fakeBearer = ["A9bC8d", "E7fG6hJ5kL"].join("");
const fakeDbUrl = ["postgres://dbuser:", "P%40ssW0rd", "-long.Random9@db.example:5432/app"].join(
  "",
);
const cleanText = "Wake summary:\r\nlines; docs/api-key.md and config.ts.\n";

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

  it("rejects unsafe review and board author fields without returning secret content", () => {
    for (const field of ["question", "reason", "summary", "body", "lastError"] as const) {
      const result = applyAuthorTextPolicy(field, `Review text ${providerToken}`);

      expect(result).toEqual({
        _tag: "Rejected",
        error: { _tag: "SecretDetected", field },
      });
      expect(JSON.stringify(result)).not.toContain(providerToken);
    }
  });

  it("preserves safe review and board author fields byte-for-byte", () => {
    const input = "Question and summary:\r\nKeep this line.\n";

    for (const field of ["question", "reason", "summary", "body", "lastError"] as const) {
      expect(applyAuthorTextPolicy(field, input)).toEqual({ _tag: "Accepted", text: input });
    }
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
    const result = applyDerivedTextPolicy("wake", cleanText);

    expect(result).toEqual({ _tag: "Unchanged", text: cleanText });
    expect(projectDerivedText("wake", cleanText)).toBe(cleanText);
    if (result._tag === "Unchanged") {
      expect(Buffer.from(result.text).equals(Buffer.from(cleanText))).toBe(true);
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

  it("is idempotent: projecting twice matches projecting once", () => {
    const secretInputs = [
      `Provider token: ${providerToken}`,
      'api_key="' + fakeValue + '"',
      "Cookie: session=" + fakeSession + "; theme=dark",
    ];

    for (const purpose of ["summary", "wake", "completion-preview", "read"] as const) {
      for (const input of secretInputs) {
        const once = projectDerivedText(purpose, input);
        expect(once).toContain(SECRET_REDACTION_LABEL);
        expect(once).not.toContain(providerToken);
        expect(projectDerivedText(purpose, once)).toBe(once);
      }
      expect(projectDerivedText(purpose, cleanText)).toBe(cleanText);
    }
  });

  it("reports the second derived-text application as Unchanged", () => {
    const first = applyDerivedTextPolicy("summary", `Provider token: ${providerToken}`);

    expect(first._tag).toBe("Redacted");
    if (first._tag === "Redacted") {
      expect(applyDerivedTextPolicy("summary", first.text)).toEqual({
        _tag: "Unchanged",
        text: first.text,
      });
    }
  });

  it("detects common structured credential formats with the shared rules", () => {
    const privateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/ab",
      "zyxwvutsrqponmlkjihgfedcba9876543210+/AB",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJ1c2VyLWlkLTEyMzQ1Njc4OTAiLCJleHAiOjE3MDAwMDAwMDB9",
      "abcdefghijklmnopqrstuvwxyz1234567890",
    ].join(".");
    const input = [
      "API_KEY=" + fakeComplex,
      "Authorization: Bearer " + fakeBearer,
      fakeDbUrl,
      "Cookie: session=" + fakeSession + "; theme=dark",
      privateKey,
      jwt,
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
    expectSecretPair(
      ["sk", "-", "7f3a9c4e5b6d0789", "QwErTyUiOp"].join(""),
      "disk-sk-activity-monitor-v2",
    );
  });

  it("keeps placeholder passwords clean and detects escaped quoted values", () => {
    expectSecretPair(
      'password="ab\\"cdEfGhIjKlMnOpQrStUvWx"',
      ["password", "=", "changeme123"].join(""),
    );
  });

  it("keeps generated camel-case identifiers clean", () => {
    expectSecretPair(
      'const accessToken = "' + fakeComplex + '";',
      'const accessToken = "generateAccessToken2Now";',
    );
  });

  it("detects API keys with spaces in their names", () => {
    expectSecretPair('api key = "' + fakeValue + '"', "api key = process.env.API_KEY");
  });

  it("detects values assigned to the bare key name", () => {
    expectSecretPair(["key", "=", fakeValue].join(""), "key=makeKey()");
  });

  it("detects values assigned to the bare pwd name", () => {
    expectSecretPair(["pwd", "=", fakeValue].join(""), "pwd=changeme123");
  });

  it("detects values assigned to the bare pass name", () => {
    expectSecretPair(["pass", "=", fakeValue].join(""), "pass=changeme123");
  });

  it("detects JWTs with an empty signature segment", () => {
    expectSecretPair(
      ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiIxMjM0In0", ""].join("."),
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
    expectSecretPair(["xoxo", "-", "123456789012-abcdefghijklmnop"].join(""), "xoxo-<token>");
    expectSecretPair(["xoxe", "-", "123456789012-abcdefghijklmnop"].join(""), "xoxe-<token>");
  });

  it("detects Stripe restricted keys", () => {
    expectSecretPair(["rk_live", "_", "51H8xYzAbCdEfGhIjKlMnOpQr"].join(""), "rk_live_<key>");
  });

  it("detects AWS key IDs only when surrounding text supplies context", () => {
    const awsKeyId = ["AKIA", "1234567890ABCDEF"].join("");

    expectSecretPair("key=" + awsKeyId, awsKeyId);
    expectSecretPair("AWS_ACCESS_KEY_ID=" + awsKeyId, awsKeyId);
    expectSecretPair("https://example.test/?AWS_ACCESS_KEY_ID=" + awsKeyId, awsKeyId);
  });

  it("uses capture indices when a value also appears in its key", () => {
    const value = fakeValue;
    const secret = value + "key=" + value;

    expectSecretPair(secret, "key=makeKey()");
    expect(applyDerivedTextPolicy("read", secret)).toEqual({
      _tag: "Redacted",
      text: value + "key=" + SECRET_REDACTION_LABEL,
      redactedCount: 1,
    });
  });
});

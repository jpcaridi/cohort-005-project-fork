import { describe, it, expect } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { knockNotifier } from "~/lib/knock-notifier.server";

// Signs locally with a throwaway key; nothing here calls Knock.
describe("knockNotifier.signUserToken", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const feed = {
    signingKey: privateKey,
    publicApiKey: "pk_test_public",
    feedChannelId: "feed-channel",
  };

  it("signs an RS256 token for the person, expiring in an hour", async () => {
    const notifier = knockNotifier("sk_test_secret", { feed });

    const access = await notifier.signUserToken(2);

    expect(access).not.toBeNull();
    if (!access) return;
    expect(access.userId).toBe("2");
    expect(access.publicApiKey).toBe("pk_test_public");
    expect(access.feedChannelId).toBe("feed-channel");
    const { header, payload, signatureValid } = readJwt(
      access.userToken,
      publicKey
    );
    expect(header.alg).toBe("RS256");
    expect(signatureValid).toBe(true);
    expect(payload.sub).toBe("2");
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60 * 60);
  });

  it("gives no Feed access when the feed isn't configured", async () => {
    const notifier = knockNotifier("sk_test_secret", { feed: null });

    expect(await notifier.signUserToken(2)).toBeNull();
  });
});

function readJwt(token: string, publicKey: string) {
  const [header, payload, signature] = token.split(".");
  const decode = (part: string) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return {
    header: decode(header) as { alg?: string },
    payload: decode(payload) as { sub?: string; iat?: number; exp?: number },
    signatureValid: verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url")
    ),
  };
}

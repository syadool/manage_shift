/** リフレッシュトークンの暗号化 (AES-GCM)。鍵は TOKEN_ENCRYPTION_KEY (32 バイトを base64) */

const b64urlEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64Decode = (s: string) => {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = b64Decode(secret.trim());
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY は 32 バイトを base64 で指定してください");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 平文 → base64url(iv(12) || 暗号文) */
export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(secret), new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function decrypt(secret: string, encoded: string): Promise<string> {
  const bytes = b64Decode(encoded);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await importKey(secret),
    bytes.slice(12),
  );
  return new TextDecoder().decode(pt);
}

/** PKCE (S256) の code_challenge */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

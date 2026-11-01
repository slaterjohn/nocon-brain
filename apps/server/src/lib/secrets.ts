import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The 32-byte key that encrypts stored secrets (docs/architecture.md: `NCB_SECRET_KEY`, generated into
 * `/data/secrets` if absent). Derived with SHA-256 from the configured string so any length works.
 */
export function loadSecretKey(configured: string | undefined, dataDir: string): Buffer {
  if (configured) return createHash("sha256").update(configured).digest();
  const dir = path.join(dataDir, "secrets");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "secret.key");
  try {
    return createHash("sha256").update(fs.readFileSync(file, "utf8").trim()).digest();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const generated = randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600, flag: "wx" });
  return createHash("sha256").update(generated).digest();
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<ciphertext>` in base64url. */
export function encryptSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(":");
}

export function decryptSecret(key: Buffer, token: string): string {
  const [v, iv, tag, data] = token.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

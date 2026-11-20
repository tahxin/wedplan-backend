import { randomBytes, scrypt } from "node:crypto";

/**
 * Hashes a password exactly the way Better Auth does for its `credential`
 * provider (see @better-auth/utils/password, node build).
 *
 * Format: "<16-byte hex salt>:<64-byte hex key>"
 */
const config = { N: 16384, r: 16, p: 1, dkLen: 64 };

function generateKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      config.dkLen,
      {
        N: config.N,
        r: config.r,
        p: config.p,
        maxmem: 128 * config.N * config.r * 2,
      },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await generateKey(password, salt)).toString("hex")}`;
}

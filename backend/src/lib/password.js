const crypto = require("crypto");

const COMMON = new Set([
  "password", "password1", "password12", "password123", "12345678", "123456789", "1234567890", "qwertyui",
  "qwerty123", "iloveyou", "admin123", "welcome1", "letmein1", "abc12345", "11111111", "00000000",
]);

// Returns an error message, or null when the password is acceptable. The upper
// bound exists because bcrypt silently ignores everything after 72 bytes.
function passwordProblem(pw, { email } = {}) {
  if (typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (Buffer.byteLength(pw, "utf8") > 72) return "Password must be at most 72 bytes";
  if (/^(.)\1+$/.test(pw)) return "Password is too simple";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common — choose another";
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return "Password must not be your e-mail address";
  return null;
}

// Readable temporary password (no look-alike characters), shown once to the admin.
function generateTempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { passwordProblem, generateTempPassword };

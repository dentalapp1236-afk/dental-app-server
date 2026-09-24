// Phone numbers reach us as free text — User.phone has no format validation, so
// what is stored is whatever someone typed: "0300-1234567", "+92 300 1234567",
// "923001234567", "0092 300 1234567". WhatsApp needs strict E.164, and WAHA
// needs that again with the "+" stripped as "<digits>@c.us".
//
// Everything here is pure and side-effect free, so the audit script can run it
// across the whole database without touching a single record.

const DEFAULT_COUNTRY = "PK";

// Pakistan: country code 92, mobiles are 3XXXXXXXXX (ten digits, always
// starting with 3). Landlines are rejected rather than normalised — they can
// never receive WhatsApp, and a number that silently fails later is worse than
// one that fails here where we can report it.
const COUNTRIES = {
  PK: { code: "92", mobile: /^3\d{9}$/ },
};

// Normalise a raw phone string to E.164 ("+923001234567"), or null when it
// isn't a mobile number we can reach. Null is a real answer, not an error —
// callers are expected to skip those recipients.
export function toE164(raw, country = DEFAULT_COUNTRY) {
  if (typeof raw !== "string") return null;
  const spec = COUNTRIES[country];
  if (!spec) return null;

  // Drop spaces, dashes, brackets and dots; keep digits and a leading plus.
  let s = raw.trim().replace(/[^\d+]/g, "");
  if (!s) return null;

  // "00" is the international access prefix — it means exactly what "+" means.
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  let national;
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    // Another country's number is out of scope rather than wrong: we only know
    // how to validate the one country we operate in.
    if (!digits.startsWith(spec.code)) return null;
    national = digits.slice(spec.code.length);
  } else if (s.startsWith("0")) {
    national = s.slice(1); // "03001234567"
  } else if (s.startsWith(spec.code) && s.length === spec.code.length + 10) {
    national = s.slice(spec.code.length); // "923001234567", no plus
  } else {
    national = s; // "3001234567"
  }

  return spec.mobile.test(national) ? `+${spec.code}${national}` : null;
}

// WAHA addresses a chat as "<digits>@c.us" — E.164 without the plus.
export function toChatId(e164) {
  return e164 ? `${e164.replace(/^\+/, "")}@c.us` : null;
}

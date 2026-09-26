// WAHA driver — the UNOFFICIAL route, running the NOWEB (Baileys) engine on a
// VPS we control.
//
// This is temporary, in place only until the business is registered and Meta's
// Cloud API is available. It implements the same tiny interface a future
// cloud.js will, so switching is a config change rather than a rewrite:
//
//     configured        is this driver usable at all?
//     sendText          send one message, never throw
//     sessionStatus     is the WhatsApp session still alive?
//
// WAHA's API can send WhatsApp messages as us, so treat WAHA_API_KEY as a
// credential of the same weight as a database password.

const URL_BASE = (process.env.WAHA_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.WAHA_API_KEY || "";
const SESSION = process.env.WAHA_SESSION || "default";
const TIMEOUT_MS = Number(process.env.WAHA_TIMEOUT_MS || 20000);

// Typing simulation. WhatsApp flags accounts that fire text with no presence
// activity in front of it, so every send is preceded by a read receipt and a
// typing indicator held for a spell that scales with the message length —
// a 200-character reminder "takes longer to type" than a short one.
const TYPE_BASE_MS = Number(process.env.WHATSAPP_TYPE_BASE_MS || 1200);
const TYPE_PER_CHAR_MS = Number(process.env.WHATSAPP_TYPE_PER_CHAR_MS || 25);
const TYPE_MAX_MS = Number(process.env.WHATSAPP_TYPE_MAX_MS || 10000);
// Marking the chat read before we send also clears anything the patient sent
// us. Set WHATSAPP_SEND_SEEN=false if you would rather not put blue ticks on
// messages nobody has actually read.
const SEND_SEEN = process.env.WHATSAPP_SEND_SEEN !== "false";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Length-scaled, then jittered +/-25%. Never a round number, never the same
// twice — a constant typing pause is as mechanical as no pause at all.
function typingMsFor(text) {
  const base = Math.min(TYPE_MAX_MS, TYPE_BASE_MS + String(text).length * TYPE_PER_CHAR_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export const configured = !!(URL_BASE && API_KEY);
export const driverName = "waha";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      "X-Api-Key": API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.message || data?.error || text?.slice(0, 200) || "";
    throw new Error(`WAHA ${method} ${path} -> ${res.status} ${detail}`.trim());
  }
  return data;
}

// Presence steps. Cosmetic in the sense that the message still goes without
// them — so a failure here is swallowed rather than aborting the send — but
// they are what makes the traffic look like a person rather than a script.
async function presence(path, chatId) {
  try {
    await call(path, { method: "POST", body: { session: SESSION, chatId } });
  } catch (err) {
    console.warn(`[waha] ${path} failed (continuing): ${err?.message}`);
  }
}

// Send one message, wrapped in the presence sequence WAHA recommends for
// avoiding a block: mark read, start typing, hold, stop typing, then send.
// Returns { ok, id, error } and never throws — a WhatsApp failure must never
// take down the appointment that triggered it.
export async function sendText(chatId, text) {
  if (!configured) return { ok: false, error: "WAHA_URL / WAHA_API_KEY not set" };
  try {
    if (SEND_SEEN) await presence("/api/sendSeen", chatId);
    await presence("/api/startTyping", chatId);
    await sleep(typingMsFor(text));
    await presence("/api/stopTyping", chatId);

    const data = await call("/api/sendText", {
      method: "POST",
      body: { session: SESSION, chatId, text },
    });
    // WAHA returns the message envelope; the id shape varies by engine.
    const id = data?.id?._serialized || data?.id || data?.key?.id || null;
    return { ok: true, id: id ? String(id) : null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Is the session still paired and working? Used by the health check, because
// the way this fails in practice is silently: the session logs out and every
// send fails until somebody notices. Expected status is "WORKING"; anything
// else (SCAN_QR_CODE, STOPPED, FAILED) needs a human.
export async function sessionStatus() {
  if (!configured) return { ok: false, status: "not_configured" };
  try {
    const data = await call(`/api/sessions/${encodeURIComponent(SESSION)}`);
    return { ok: true, status: data?.status || "unknown", engine: data?.engine?.engine || null };
  } catch (err) {
    return { ok: false, status: "unreachable", error: err?.message || String(err) };
  }
}

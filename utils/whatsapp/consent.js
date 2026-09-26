// WhatsApp consent, applied in one place because it is applied in several.
//
// The timestamp and source are stamped HERE rather than accepted from the
// request body. Consent that can't be evidenced later isn't consent, and a
// client-supplied "I agreed last March" is worth nothing. With every clinic
// sending from one shared number we are the sender of record, so this is our
// obligation rather than the dentist's.

// Mutate a Mongoose document. Use on paths that end in .save().
export function applyWhatsappConsent(doc, optIn, source) {
  if (optIn === undefined || optIn === null) return;
  const next = optIn === true || optIn === "true";
  if (next === !!doc.whatsappOptIn) return; // no change: don't re-stamp the date
  doc.whatsappOptIn = next;
  doc.whatsappOptInAt = next ? new Date() : undefined;
  doc.whatsappOptInSource = next ? source : undefined;
}

// The same thing as $set/$unset fragments, for paths that use
// findOneAndUpdate and therefore never run the save hook.
export function whatsappConsentOps(current, optIn, source) {
  if (optIn === undefined || optIn === null) return { set: {}, unset: {} };
  const next = optIn === true || optIn === "true";
  if (next === !!current) return { set: {}, unset: {} };
  return next
    ? { set: { whatsappOptIn: true, whatsappOptInAt: new Date(), whatsappOptInSource: source }, unset: {} }
    : { set: { whatsappOptIn: false }, unset: { whatsappOptInAt: "", whatsappOptInSource: "" } };
}

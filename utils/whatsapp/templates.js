// The messages we send, defined as templates with named parameters — even
// though WAHA happily takes free-form text and needs none of this.
//
// That is deliberate. When the business is registered and we move to Meta's
// Cloud API, every message must be pre-registered with Meta and the text that
// goes out has to match the approved wording EXACTLY. Defining them here now
// means that migration is a driver swap rather than a rewrite of every call
// site. `params` doubles as the POSITIONAL order Meta uses ({{1}}, {{2}}, …),
// so a Cloud driver can build its payload mechanically from the same objects.
//
// Two rules every body follows, both forced on us by sending from ONE shared
// number on behalf of every clinic:
//   1. Name the clinic in the first line. The message arrives from
//      "MyDentalBooking", not from the patient's own dentist, so without this
//      the patient has no idea who is contacting them.
//   2. End by pointing at the clinic's own phone. This number does not take
//      replies, and a shared inbox that silently swallows them is worse than
//      no WhatsApp at all.

const REPLY_FOOTER = (clinicPhone) =>
  clinicPhone
    ? `\n\nTo change or cancel, please call the clinic on ${clinicPhone}. This number doesn't take replies.`
    : `\n\nTo change or cancel, please contact your clinic. This number doesn't take replies.`;

export const TEMPLATES = {
  appointment_confirmed: {
    params: ["patientName", "clinicName", "when", "clinicPhone"],
    render: (v) =>
      `Hello ${v.patientName}, your appointment at ${v.clinicName} is confirmed for ${v.when}.` +
      REPLY_FOOTER(v.clinicPhone),
  },

  appointment_reminder: {
    params: ["patientName", "clinicName", "when", "clinicPhone"],
    render: (v) =>
      `Hello ${v.patientName}, a reminder that your appointment at ${v.clinicName} is tomorrow, ${v.when}.` +
      REPLY_FOOTER(v.clinicPhone),
  },

  appointment_rescheduled: {
    params: ["patientName", "clinicName", "when", "clinicPhone"],
    render: (v) =>
      `Hello ${v.patientName}, your appointment at ${v.clinicName} has been moved to ${v.when}.` +
      REPLY_FOOTER(v.clinicPhone),
  },

  invoice_due: {
    params: ["dentistName", "amount", "month", "dueDate"],
    render: (v) =>
      `Hello ${v.dentistName}, your MyDentalBooking invoice for ${v.month} (${v.amount}) is due on ${v.dueDate}.` +
      `\n\nYou can view it and the bank details in the app under Invoices.`,
  },
};

// Render a template, failing loudly on a missing parameter rather than posting
// "undefined" to a patient. Returns the finished text.
export function renderTemplate(name, values = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Unknown WhatsApp template: ${name}`);
  // clinicPhone is genuinely optional — the footer has wording for both cases.
  const missing = tpl.params.filter(
    (p) => p !== "clinicPhone" && (values[p] === undefined || values[p] === null || values[p] === "")
  );
  if (missing.length) {
    throw new Error(`WhatsApp template "${name}" is missing: ${missing.join(", ")}`);
  }
  return tpl.render(values);
}

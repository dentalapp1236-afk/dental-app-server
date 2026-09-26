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
//   1. Name the dentist in the first line. The message arrives from
//      "MyDentalBooking", not from the patient's own dentist, so without this
//      the patient has no idea who is contacting them. Note the preposition:
//      an appointment is WITH a person, AT a place.
//   2. Say plainly that replies go nowhere. Patients will otherwise answer
//      these, and nobody is reading that inbox.

const FOOTER =
  "\n\nThis number doesn't take replies.\nwww.mydentalbooking.com - Bookings made easy";

// `urgent` marks the messages a person is waiting on. Sends are spaced 30-60
// seconds apart to avoid a block, so a batch of reminders can occupy the queue
// for half an hour — and a booking confirmation arriving 30 minutes after the
// booking is worse than useless. Urgent messages jump that queue; the batch
// jobs, which nobody is watching, wait their turn.
export const TEMPLATES = {
  appointment_confirmed: {
    urgent: true,
    params: ["patientName", "dentistName", "when"],
    render: (v) =>
      `Hello ${v.patientName}, your appointment with ${v.dentistName} is confirmed for ${v.when}.` +
      FOOTER,
  },

  appointment_reminder: {
    params: ["patientName", "dentistName", "when"],
    render: (v) =>
      `Hello ${v.patientName}, a reminder that your appointment with ${v.dentistName} is tomorrow, ${v.when}.` +
      FOOTER,
  },

  appointment_rescheduled: {
    urgent: true,
    params: ["patientName", "dentistName", "when"],
    render: (v) =>
      `Hello ${v.patientName}, your appointment with ${v.dentistName} has been moved to ${v.when}.` +
      FOOTER,
  },

  invoice_due: {
    params: ["dentistName", "amount", "month", "dueDate"],
    render: (v) =>
      `Hello ${v.dentistName}, your MyDentalBooking invoice for ${v.month} (${v.amount}) is due on ${v.dueDate}.` +
      `\n\nYou can view it and the bank details in the app in Invoices tab.`,
  },
};

// Render a template, failing loudly on a missing parameter rather than posting
// "undefined" to a patient. Returns the finished text.
export function renderTemplate(name, values = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Unknown WhatsApp template: ${name}`);
  const missing = tpl.params.filter(
    (p) => values[p] === undefined || values[p] === null || values[p] === ""
  );
  if (missing.length) {
    throw new Error(`WhatsApp template "${name}" is missing: ${missing.join(", ")}`);
  }
  return tpl.render(values);
}

// Is anyone actually waiting on this message right now?
export const isUrgent = (name) => !!TEMPLATES[name]?.urgent;

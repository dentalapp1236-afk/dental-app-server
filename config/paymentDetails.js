// The platform's own bank account that clinics transfer their subscription
// fee to — shown on the invoice PDF (utils/invoicePdf.js) and in-app to both
// admin and the dentist (routes/admin.js, routes/invoices.js), so it lives in
// one place rather than being duplicated with its own fallback in each.
export function getPaymentDetails() {
  return {
    bankName: process.env.PAYMENT_BANK_NAME || "Allied Bank Limited",
    accountTitle: process.env.PAYMENT_ACCOUNT_TITLE || "Hamza Mansoor",
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || "04810010078559090018",
  };
}

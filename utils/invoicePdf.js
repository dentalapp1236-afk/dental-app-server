import PDFDocument from "pdfkit";
import { DEFAULT_MONTHLY_FEE } from "../jobs/invoices.js";

const BLUE = "#1877f2";
const INK = "#1c1e21";
const MUTED = "#65676b";
const BORDER = "#dadde1";
const GREEN = "#1a7f37";
const AMBER = "#a85b00";
const RED = "#b42318";

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 495; // A4 (595pt) minus 2x margin

const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
const monthLabel = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

function statusInfo(invoice) {
  if (invoice.status === "paid") return { label: "PAID", color: GREEN, bg: "#e7f6ec" };
  const overdue = new Date(invoice.dueDate) < new Date();
  return overdue
    ? { label: "OVERDUE", color: RED, bg: "#fdecea" }
    : { label: "UNPAID", color: AMBER, bg: "#fff4e5" };
}

// Renders a one-page subscription invoice PDF into `stream` (an Express
// response or a filesystem write stream) and resolves once fully written.
// `issuedBy` is the admin's display name, shown in the footer signature line.
export function renderInvoicePdf(stream, { invoice, dentist, issuedBy }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
    doc.on("error", reject);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);

    const left = PAGE_MARGIN;
    const right = PAGE_MARGIN + CONTENT_WIDTH;
    let y = PAGE_MARGIN;

    // A label:value pair on one line, label in muted gray then value in ink,
    // left-aligned starting at (x, y).
    const labelValue = (label, value, x, yy, width) => {
      doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(label, x, yy, { continued: true, width });
      doc.font("Helvetica-Bold").fillColor(INK).text(value);
    };

    // ---- Header: wordmark left, "INVOICE" + number right ----
    doc.font("Helvetica-Bold").fontSize(20).fillColor(BLUE).text("MyDentalBooking", left, y);
    doc.font("Helvetica-Bold").fontSize(24).fillColor(INK).text("INVOICE", left, y, { width: CONTENT_WIDTH, align: "right" });
    y += 26;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("Clinic management platform", left, y);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`No. INV-${invoice.month}`, left, y, { width: CONTENT_WIDTH, align: "right" });
    y += 22;

    doc.moveTo(left, y).lineTo(right, y).lineWidth(2).strokeColor(BLUE).stroke();
    y += 22;

    // ---- Billed to / Invoice details, two columns ----
    const colWidth = CONTENT_WIDTH / 2 - 10;
    const rightColX = left + CONTENT_WIDTH / 2 + 10;
    const blockTop = y;

    // Advances the cursor by the ACTUAL wrapped height of each line (address
    // in particular can wrap to 2-3 lines) rather than a fixed line height,
    // so later lines never overlap a wrapped one above them.
    const wrappedLine = (text, font, size, color, yy) => {
      doc.font(font).fontSize(size).fillColor(color);
      doc.text(text, left, yy, { width: colWidth });
      return yy + doc.heightOfString(text, { width: colWidth, font, fontSize: size }) + 4;
    };

    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("BILLED TO", left, y, { characterSpacing: 0.5 });
    let ly = y + 14;
    ly = wrappedLine(`Dr. ${dentist?.name || "—"}`, "Helvetica-Bold", 11, INK, ly) + 2;
    if (dentist?.clinicName) ly = wrappedLine(dentist.clinicName, "Helvetica", 10, INK, ly);
    if (dentist?.address) ly = wrappedLine(dentist.address, "Helvetica", 10, MUTED, ly);
    if (dentist?.phone) ly = wrappedLine(dentist.phone, "Helvetica", 10, MUTED, ly);

    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("INVOICE DETAILS", rightColX, y, { width: colWidth, characterSpacing: 0.5 });
    let ry = y + 14;
    labelValue("Issue date: ", fmtDate(invoice.issueDate), rightColX, ry, colWidth);
    ry += 13;
    labelValue("Due date: ", fmtDate(invoice.dueDate), rightColX, ry, colWidth);
    ry += 13;
    labelValue("Billing period: ", monthLabel(invoice.month), rightColX, ry, colWidth);
    ry += 13;

    y = Math.max(ly, ry) + 20;

    // ---- Line-item table ----
    const tableTop = y;
    const rowHeight = 26;
    doc.rect(left, tableTop, CONTENT_WIDTH, rowHeight).fill(BLUE);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff").text("DESCRIPTION", left + 12, tableTop + 8, { characterSpacing: 0.5 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff").text("AMOUNT", left, tableTop + 8, { width: CONTENT_WIDTH - 12, align: "right", characterSpacing: 0.5 });
    y = tableTop + rowHeight + 12;

    const discounted = Number(invoice.amount) < DEFAULT_MONTHLY_FEE;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text("MyDentalBooking monthly subscription", left + 12, y, { width: 300 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(money(invoice.amount), left, y, { width: CONTENT_WIDTH - 12, align: "right" });
    y += 14;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`${monthLabel(invoice.month)}${discounted ? " · discounted rate" : ""}`, left + 12, y, { width: 300 });
    y += 22;

    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER).stroke();
    y += 10;
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Subtotal", left, y, { width: 300 });
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(money(invoice.amount), left, y, { width: CONTENT_WIDTH - 12, align: "right" });
    y += 18;

    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
    y += 10;
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text("Total due", left, y, { width: 300 });
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(money(invoice.amount), left, y, { width: CONTENT_WIDTH - 12, align: "right" });
    y += 34;

    // ---- Status pill ----
    // Drawn as a real vector dot, not a "●" character — PDFKit's default
    // Helvetica font uses WinAnsi encoding and renders that glyph as garbage.
    const st = statusInfo(invoice);
    doc.font("Helvetica-Bold").fontSize(10);
    const dotR = 3;
    const textWidth = doc.widthOfString(st.label);
    const pillWidth = dotR * 2 + 8 + textWidth + 24;
    doc.roundedRect(left, y, pillWidth, 20, 10).fill(st.bg);
    doc.circle(left + 14, y + 10, dotR).fill(st.color);
    doc.fillColor(st.color).text(st.label, left + 14 + dotR + 6, y + 5);
    y += 40;

    // ---- Payment details box ----
    const bank = process.env.PAYMENT_BANK_NAME || "Allied Bank Limited";
    const acctTitle = process.env.PAYMENT_ACCOUNT_TITLE || "Hamza Mansoor";
    const acctNumber = process.env.PAYMENT_ACCOUNT_NUMBER || "04810010078559090018";

    const boxTop = y;
    const boxPad = 14;
    const boxHeight = 96;
    doc.roundedRect(left, boxTop, CONTENT_WIDTH, boxHeight, 8).fill("#eaf1fb");
    let py = boxTop + boxPad;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE).text("PAYMENT DETAILS", left + boxPad, py, { characterSpacing: 0.5 });
    py += 18;
    const payRow = (label, value) => {
      doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(label, left + boxPad, py, { width: 110 });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(value, left + boxPad + 110, py, { width: CONTENT_WIDTH - boxPad * 2 - 110 });
      py += 17;
    };
    payRow("Bank", bank);
    payRow("Account title", acctTitle);
    payRow("Account number", acctNumber);
    y = boxTop + boxHeight + 24;

    // ---- Footer ----
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER).stroke();
    y += 12;
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        "Please transfer the amount to the account above and share the payment screenshot so we can mark this invoice as paid.",
        left,
        y,
        { width: CONTENT_WIDTH }
      );
    y += 18;
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(`MyDentalBooking · Issued by ${issuedBy || "the platform admin"} · Thank you for your business.`, left, y, {
        width: CONTENT_WIDTH,
      });

    doc.end();
  });
}

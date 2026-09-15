import PDFDocument from "pdfkit";

const money = (n, currency) => `${currency || "PKR"} ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// Renders a one-page subscription invoice PDF into `stream` (an Express
// response or a filesystem write stream) and resolves once fully written.
export function renderInvoicePdf(stream, { invoice, dentist }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.on("error", reject);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);

    const overdue = invoice.status !== "paid" && new Date(invoice.dueDate) < new Date();
    const statusLabel = invoice.status === "paid" ? "PAID" : overdue ? "OVERDUE" : "UNPAID";
    const statusColor = invoice.status === "paid" ? "#1a7f37" : overdue ? "#b42318" : "#a85b00";

    // Header
    doc.fontSize(20).fillColor("#1c1e21").text("MyDentalBooking", { continued: false });
    doc.fontSize(10).fillColor("#65676b").text("Clinic subscription invoice");
    doc.moveDown(1.5);

    doc.fontSize(16).fillColor("#1c1e21").text(`Invoice — ${invoice.month}`);
    doc.fontSize(9).fillColor("#65676b").text(`Invoice ID: ${invoice._id}`);
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor(statusColor).text(`Status: ${statusLabel}`);
    doc.moveDown(1);

    // Billed to
    doc.fontSize(11).fillColor("#1c1e21").text("Billed to:");
    doc.fontSize(11).fillColor("#1c1e21").text(dentist?.clinicName || dentist?.name || "—");
    doc.fontSize(10).fillColor("#65676b");
    if (dentist?.name) doc.text(dentist.name);
    if (dentist?.address) doc.text(dentist.address);
    if (dentist?.email) doc.text(dentist.email);
    if (dentist?.phone) doc.text(dentist.phone);
    doc.moveDown(1.5);

    // Details
    const rows = [
      ["Description", `Monthly subscription fee — ${invoice.month}`],
      ["Amount", money(invoice.amount, invoice.currency)],
      ["Issue date", fmtDate(invoice.issueDate)],
      ["Due date", fmtDate(invoice.dueDate)],
    ];
    if (invoice.status === "paid" && invoice.paidAt) rows.push(["Paid on", fmtDate(invoice.paidAt)]);
    if (invoice.note) rows.push(["Note", invoice.note]);

    doc.fontSize(11);
    for (const [label, value] of rows) {
      const y = doc.y;
      doc.fillColor("#65676b").text(label, 50, y, { width: 140 });
      doc.fillColor("#1c1e21").text(String(value), 200, y, { width: 345 });
      doc.moveDown(0.6);
    }

    doc.moveDown(1.5);
    doc.fontSize(18).fillColor("#1c1e21").text(`Total due: ${money(invoice.amount, invoice.currency)}`, {
      align: "right",
    });

    doc.moveDown(3);
    doc
      .fontSize(9)
      .fillColor("#65676b")
      .text(
        "Thank you for being a MyDentalBooking partner clinic. For questions about this invoice, please contact the platform admin.",
        { align: "center" }
      );

    doc.end();
  });
}

import PDFDocument from 'pdfkit';

const money = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
};

const safeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

export const renderInvoicePdf = (invoiceDetails = {}) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: `Invoice ${safeText(invoiceDetails.invoiceNumber, 'PrintFlow')}`,
      Author: 'PrintFlow',
      Subject: `Invoice for order ${safeText(invoiceDetails.orderNumber)}`,
    },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  let y = 0;

  doc.rect(0, 0, doc.page.width, 92).fill('#1e3a8a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('PrintFlow', left, 28, { lineBreak: false });
  doc.font('Helvetica').fontSize(12).text('Invoice', left, 58, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).text(safeText(invoiceDetails.invoiceNumber, 'Invoice'), left, 58, {
    width,
    align: 'right',
    lineBreak: false,
  });

  y = 116;
  const meta = [
    ['Order number', safeText(invoiceDetails.orderNumber, '—')],
    ['Issue date', safeText(invoiceDetails.issueDate, '—')],
    ['Due date', safeText(invoiceDetails.dueDate, '—')],
    ['Payment status', safeText(invoiceDetails.status, 'sent').toUpperCase()],
  ];
  meta.forEach(([label, value]) => {
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text(label, left, y, { width: 110, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(value, left + 120, y, { width: width - 120, lineBreak: false });
    y += 16;
  });

  y += 14;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e3a8a').text('Bill to', left, y, { lineBreak: false });
  y += 18;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(safeText(invoiceDetails.customerName, 'Customer'), left, y, {
    width: 280,
  });
  y = doc.y + 2;
  if (invoiceDetails.customerEmail) {
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(invoiceDetails.customerEmail, left, y, { width: 280 });
    y = doc.y + 2;
  }
  if (invoiceDetails.billToAddress) {
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(invoiceDetails.billToAddress, left, y, { width: 280 });
    y = doc.y + 2;
  }

  y += 18;
  const columns = [
    { label: 'Item', x: left, w: width - 220, align: 'left' },
    { label: 'Qty', x: right - 210, w: 40, align: 'right' },
    { label: 'Price', x: right - 160, w: 70, align: 'right' },
    { label: 'Amount', x: right - 80, w: 80, align: 'right' },
  ];

  const drawHeader = () => {
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#d1d5db').lineWidth(1).stroke();
    y += 8;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280');
    columns.forEach((column) => {
      doc.text(column.label, column.x, y, { width: column.w, align: column.align, lineBreak: false });
    });
    y += 16;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#d1d5db').stroke();
    y += 10;
  };

  drawHeader();

  const items = Array.isArray(invoiceDetails.items) && invoiceDetails.items.length
    ? invoiceDetails.items
    : [{ name: 'Print order', quantity: 1, unitPrice: invoiceDetails.amount, subtotal: invoiceDetails.amount }];

  items.forEach((item) => {
    const name = safeText(item.name, 'Print item');
    doc.font('Helvetica').fontSize(10);
    const nameHeight = doc.heightOfString(name, { width: columns[0].w });
    if (y + nameHeight > doc.page.height - 140) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    const rowY = y;
    doc.fillColor('#111827').text(name, columns[0].x, rowY, { width: columns[0].w });
    doc.text(String(item.quantity || 1), columns[1].x, rowY, { width: columns[1].w, align: 'right', lineBreak: false });
    doc.text(money(item.unitPrice), columns[2].x, rowY, { width: columns[2].w, align: 'right', lineBreak: false });
    doc.text(money(item.subtotal), columns[3].x, rowY, { width: columns[3].w, align: 'right', lineBreak: false });
    y = rowY + Math.max(nameHeight, 14) + 8;
  });

  if (y + 110 > doc.page.height - 60) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  y += 4;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#d1d5db').stroke();
  y += 14;

  const totals = [
    ['Subtotal', money(invoiceDetails.subtotal)],
    ['Tax', money(invoiceDetails.tax)],
    ['Shipping', money(invoiceDetails.shipping)],
  ];
  totals.forEach(([label, value]) => {
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(label, right - 190, y, { width: 100, align: 'right', lineBreak: false });
    doc.fillColor('#111827').text(value, right - 80, y, { width: 80, align: 'right', lineBreak: false });
    y += 16;
  });

  y += 4;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3a8a').text('Total', right - 190, y, { width: 100, align: 'right', lineBreak: false });
  doc.text(money(invoiceDetails.amount), right - 80, y, { width: 80, align: 'right', lineBreak: false });

  doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(
    'Thank you for your business. PrintFlow printing and design hub.',
    left,
    doc.page.height - 64,
    { width, align: 'center' }
  );

  doc.end();
});

import nodemailer from 'nodemailer';
import dns from 'dns';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderInvoicePdf } from './invoicePdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedTransporter = null;
let cachedHostKey = '';

// AAAA lookups for the SMTP host hang on this network, and Nodemailer waits
// for that lookup before it opens a socket. Resolve IPv4 ourselves and connect
// to the address, keeping the hostname for TLS.
const lookupIpv4 = (hostname) => new Promise((resolve) => {
  if (!hostname || net.isIP(hostname)) {
    resolve(hostname || '');
    return;
  }
  const timer = setTimeout(() => resolve(''), 4000);
  dns.resolve4(hostname, (err, addresses) => {
    clearTimeout(timer);
    if (!err && addresses && addresses[0]) {
      resolve(addresses[0]);
      return;
    }
    dns.lookup(hostname, { family: 4 }, (lookupErr, address) => {
      resolve(!lookupErr && address ? address : '');
    });
  });
});

const getSmtpTransporter = async () => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  const hostname = process.env.SMTP_HOST;
  const ipv4 = await lookupIpv4(hostname);
  const host = ipv4 || hostname;
  const cacheKey = `${host}|${process.env.SMTP_PORT}|${process.env.SMTP_USER}`;
  if (cachedTransporter && cachedHostKey === cacheKey) return cachedTransporter;

  try {
    cachedHostKey = cacheKey;
    cachedTransporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: process.env.SMTP_SECURE !== 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        servername: hostname,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      dnsTimeout: 4000,
    });
    return cachedTransporter;
  } catch (err) {
    console.error('[MAILER] Failed to create SMTP transporter:', err);
    cachedTransporter = null;
    cachedHostKey = '';
    return null;
  }
};

const splitRecipients = (to) => {
  if (!to) return [];
  const list = Array.isArray(to) ? to : String(to).split(',');
  return [...new Set(list.map((value) => String(value).trim()).filter(Boolean))];
};

const isConnectionError = (err) =>
  /ETIMEDOUT|ECONNECTION|ESOCKET|ECONNREFUSED|ENETUNREACH|ETLS|Greeting never received|Connection timeout|timeout/i
    .test(`${err && err.code} ${err && err.message}`);

const sendWithPortFallback = async (transporter, mailOptions, to) => {
  try {
    await transporter.sendMail({ ...mailOptions, to });
    return;
  } catch (err) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    if (port === 465 && isConnectionError(err)) {
      console.error(`[MAILER] Port 465 failed for ${to} (${err.message || err}). Retrying on 587.`);
      cachedTransporter = null;
      cachedHostKey = '';
      const hostname = process.env.SMTP_HOST;
      const ipv4 = await lookupIpv4(hostname);
      const fallback = nodemailer.createTransport({
        host: ipv4 || hostname,
        port: 587,
        secure: false,
        requireTLS: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        tls: { servername: hostname },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });
      await fallback.sendMail({ ...mailOptions, to });
      return;
    }
    throw err;
  }
};

const sendMailWithSmtp = async (mailOptions) => {
  const transporter = await getSmtpTransporter();
  const recipients = splitRecipients(mailOptions.to);
  if (!transporter) {
    console.log('[MAILER] No SMTP credentials configured. Email logged to file.');
    return;
  }
  if (recipients.length === 0) {
    console.log(`[MAILER] Skipping SMTP send for "${mailOptions.subject}" — no recipient.`);
    return;
  }

  // Send one recipient at a time so one bad seed address cannot block Gmail inboxes.
  for (const to of recipients) {
    try {
      await sendWithPortFallback(transporter, mailOptions, to);
      console.log(`[MAILER] Email successfully sent to ${to} (${mailOptions.subject})`);
    } catch (err) {
      console.error(`[MAILER] SMTP send failed to ${to}:`, err.message || err);
      cachedTransporter = null;
      cachedHostKey = '';
      try {
        const retryTransporter = await getSmtpTransporter();
        if (!retryTransporter) throw err;
        await sendWithPortFallback(retryTransporter, mailOptions, to);
        console.log(`[MAILER] Email retry succeeded for ${to} (${mailOptions.subject})`);
      } catch (retryErr) {
        console.error(`[MAILER] SMTP retry failed to ${to}:`, retryErr.message || retryErr);
      }
    }
  }
};

const PRODUCTION_FRONTEND_URL = 'https://visiting-frontend.onrender.com';
const LOCAL_FRONTEND_URL = 'http://localhost:5173';

const isLocalHostname = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

const toOrigin = (value) => {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
};

const isAllowedFrontendOrigin = (origin) => {
  try {
    const url = new URL(origin);
    if (isLocalHostname(url.hostname)) return true;
    if (url.protocol !== 'https:') return false;
    if (url.origin === PRODUCTION_FRONTEND_URL) return true;

    const configured = toOrigin(process.env.FRONTEND_URL);
    if (!configured) return false;
    const configuredHost = new URL(configured).hostname;
    return url.origin === configured && !isLocalHostname(configuredHost);
  } catch {
    return false;
  }
};

// Local requests keep a localhost approval link. Production requests use the live site,
// even when FRONTEND_URL is still set to localhost.
export const resolveFrontendBaseUrl = (req) => {
  const candidates = [
    req?.body?.clientOrigin,
    req?.headers?.origin,
    req?.headers?.referer,
  ];

  for (const candidate of candidates) {
    const origin = toOrigin(candidate);
    if (origin && isAllowedFrontendOrigin(origin)) return origin;
  }

  const configured = toOrigin(process.env.FRONTEND_URL);
  const configuredIsLocal = !configured || isLocalHostname(new URL(configured).hostname);
  const runningInProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

  if (runningInProduction) {
    return configuredIsLocal ? PRODUCTION_FRONTEND_URL : configured;
  }

  return configured || LOCAL_FRONTEND_URL;
};

export const sendApprovalEmail = async (toEmail, approvalId, designDetails, adminEmails = [], req) => {
  const frontendUrl = resolveFrontendBaseUrl(req);
  const approvalUrl = `${frontendUrl}/approve-card-design/${approvalId}`;
  const emailTextWithButton = `
********************************************************************************
👉 ACTION REQUIRED: APPROVE YOUR PRINTFLOW CARD DESIGN 👈
********************************************************************************

Hello,

You have requested approval for your customized card design at PrintFlow.
Please click the direct link below to view, verify, and approve your design:

➡️ CLICK HERE TO APPROVE: ${approvalUrl}

(Note: Once approved, you will be prompted to enter your shipping address and complete payment details.)

Thank you,
The PrintFlow Team
********************************************************************************
`;

  const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 30px; max-width: 600px; margin: auto; border: 2px solid #2563eb; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; margin-bottom: 25px;">
        <span style="font-size: 26px; font-weight: 800; color: #1e3a8a; letter-spacing: 0.5px;">PrintFlow Studio</span>
      </div>
      <h2 style="color: #1e3a8a; text-align: center; margin-top: 0; font-size: 20px; font-weight: 700;">Design Approval Required</h2>
      <p style="color: #4b5563; font-size: 15px; line-height: 1.6; text-align: center; margin-bottom: 30px;">
        Hello! You have requested approval for your customized card design at PrintFlow. Please click the button below to view and approve your layout:
      </p>
      
      <div style="margin: 35px 0; text-align: center;">
        <a href="${approvalUrl}" style="background-color: #10b981; color: white; padding: 15px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 8px rgba(16, 185, 129, 0.3); display: inline-block; border: 1px solid #059669; transition: all 0.2s ease;">
          👉 CLICK HERE TO APPROVE DESIGN 👈
        </a>
      </div>

      <div style="background-color: #f3f4f6; padding: 18px; border-radius: 8px; border: 1px solid #e5e7eb; text-align: center; margin-top: 30px;">
        <p style="margin: 0 0 10px 0; font-size: 12px; color: #6b7280; font-weight: bold; uppercase tracking-wider;">If the button above does not work, copy & paste this link:</p>
        <p style="margin: 0; font-size: 13px; word-break: break-all; color: #2563eb; font-family: monospace;">
          <a href="${approvalUrl}" style="color: #2563eb; text-decoration: underline; font-weight: 600;">${approvalUrl}</a>
        </p>
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
      <p style="font-size: 11px; color: #9ca3af; text-align: center; margin: 0;">
        This is an automated request from the PrintFlow Design Team. Please do not reply directly to this email.
      </p>
    </div>
  `;

  // Always write to email-log.txt for easy local testing
  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const logEntry = `
=========================================
Timestamp: ${new Date().toISOString()}
To: ${toEmail}
Subject: Action Required: Approve Your PrintFlow Card Design
Approval URL: ${approvalUrl}
-----------------------------------------
${emailTextWithButton}
=========================================
`;

  // Write to email-log.html so the developer/user can open it in a browser to see the real button
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');
  const htmlLogEntry = `
<div style="border: 2px solid #10b981; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Action Required: Approve Your PrintFlow Card Design
  </div>
  ${emailHtml}
</div>
`;

  const logPromise = fs.promises.appendFile(logFilePath, logEntry)
    .then(() => console.log(`[MAILER] Email text logged successfully to ${logFilePath}`))
    .catch((err) => ({ type: 'logError', error: err }));

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlLogEntry)
    .then(() => console.log(`[MAILER] Email HTML logged successfully to ${htmlLogFilePath}`))
    .catch((err) => ({ type: 'htmlLogError', error: err }));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Team" <${process.env.SMTP_USER}>`,
    to: [toEmail, ...splitRecipients(adminEmails)],
    subject: 'PrintFlow design approval requested',
    text: emailTextWithButton,
    html: emailHtml,
  }).catch((err) => ({ type: 'smtpError', error: err }));

  const results = await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
  results.forEach((r) => {
    if (r.status === 'rejected') {
      console.error('[MAILER] Unexpected rejection while sending approval email:', r.reason);
    } else if (r.value && r.value.type && r.value.error) {
      console.error(`[MAILER] ${r.value.type}:`, r.value.error);
    }
  });

  return approvalUrl;
};

export const sendAccountApprovedEmail = async (toEmail, fullName) => {
  const emailText = `
Hello ${fullName},

Great news! Your PrintFlow account has been accepted and activated.
You can now log in and begin using your account immediately.

If you need any help, reply to this email and our support team will assist you.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #10b981;">Your PrintFlow Account Has Been Accepted</h2>
      <p>Hi ${fullName},</p>
      <p>We’re pleased to let you know that your account has been accepted and is now active.</p>
      <p>You can log in now to start customizing print designs, managing your orders, and using PrintFlow.</p>
      <p>If you need help, just reply to this email.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[ACCOUNT APPROVAL EMAIL] Sent to ${toEmail}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write account approval text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #10b981; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Your PrintFlow Account Has Been Accepted
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write account approval HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Team" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Your PrintFlow Account Has Been Accepted',
    text: emailText,
    html: emailHtml,
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendApprovalConfirmationEmail = async (toEmail, approvalId, designType, adminEmails = []) => {
  const emailText = `
Hello,

Your card design (${designType}) with ID: ${approvalId} has been successfully approved!
You can now proceed to place your order on our platform.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #10b981;">Design Approved!</h2>
      <p>Your custom design (${designType}) has been successfully approved.</p>
      <p>Log in to complete your checkout and place your order.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[APPROVAL CONFIRMATION] Sent to ${toEmail}\n${emailText}\n`)
    .then(() => console.log(`[MAILER] Approval confirmation email text logged to ${logFilePath}`))
    .catch((err) => console.error('[MAILER] Failed to write approval confirmation email log:', err));

  const htmlEntry = `
<div style="border: 2px solid #10b981; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Your PrintFlow Design Has Been Approved!
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .then(() => console.log(`[MAILER] Approval confirmation email HTML logged successfully to ${htmlLogFilePath}`))
    .catch((err) => console.error('[MAILER] Failed to write approval confirmation HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Team" <${process.env.SMTP_USER}>`,
    to: [toEmail, ...splitRecipients(adminEmails)],
    subject: 'Your PrintFlow Design Has Been Approved!',
    text: emailText,
    html: emailHtml,
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendPendingApprovalEmail = async (toEmail, fullName) => {
  const emailText = `
Hello ${fullName},

Thank you for registering at PrintFlow!
Your account has been created successfully and is currently pending approval by the Admin.
You will receive another email once your account has been approved and activated.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #d97706;">Registration Received</h2>
      <p>Hello ${fullName},</p>
      <p>Your account has been created successfully and is currently pending approval by the Admin.</p>
      <p>You will receive an email confirmation once your account has been activated.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[PENDING APPROVAL EMAIL] Sent to ${toEmail}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write pending approval text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #d97706; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: PrintFlow Registration - Pending Approval
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write pending approval HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Team" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'PrintFlow Registration - Pending Approval',
    text: emailText,
    html: emailHtml,
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendWelcomeEmail = async (toEmail, fullName) => {
  const emailText = `
Hello ${fullName},

Welcome to PrintFlow!
Your account has been approved and activated.
You can now log in and start using the platform immediately.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #10b981;">Welcome to PrintFlow</h2>
      <p>Hi ${fullName},</p>
      <p>Your account has been approved and activated.</p>
      <p>You can now log in and start using PrintFlow.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[WELCOME EMAIL] Sent to ${toEmail}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write welcome text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #10b981; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Welcome to PrintFlow!
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write welcome HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Team" <${process.env.SMTP_USER || 'admin@printflow.com'}>`,
    to: toEmail,
    subject: 'Welcome to PrintFlow!',
    text: emailText,
    html: emailHtml,
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendInvoiceEmail = async (toEmail, invoiceDetails, options = {}) => {
  const recipients = splitRecipients(toEmail);
  if (recipients.length === 0) {
    console.log(`[MAILER] Skipping invoice ${invoiceDetails.invoiceNumber} — no recipient.`);
    return;
  }

  const isAdminCopy = options.audience === 'admin';
  const deliveredNote = options.reason === 'delivered';
  const amount = formatMoney(invoiceDetails.amount);
  const statusLabel = String(invoiceDetails.status || 'sent').toUpperCase();
  const items = Array.isArray(invoiceDetails.items) ? invoiceDetails.items : [];
  const itemText = items.length
    ? `\nItems:\n${items.map((item) => `- ${item.name || 'Print item'} × ${item.quantity || 1} @ $${formatMoney(item.unitPrice)} = $${formatMoney(item.subtotal)}`).join('\n')}\n`
    : '';
  const customerLine = invoiceDetails.customerName || invoiceDetails.customerEmail
    ? `Customer: ${invoiceDetails.customerName || 'Customer'}${invoiceDetails.customerEmail ? ` (${invoiceDetails.customerEmail})` : ''}\n`
    : '';
  const intro = isAdminCopy
    ? `Hello,\n\n${deliveredNote ? 'An order has been delivered. ' : ''}This is a copy of the customer invoice for your records. The invoice PDF is attached.\n`
    : `Hello${invoiceDetails.customerName ? ` ${invoiceDetails.customerName}` : ''},\n\n${deliveredNote ? 'Your order has been delivered. ' : ''}Please find your PrintFlow invoice below. The invoice PDF is attached.\n`;

  const emailText = `
${intro}
${isAdminCopy ? customerLine : ''}Invoice Number: ${invoiceDetails.invoiceNumber}
Order Number: ${invoiceDetails.orderNumber}
Issue Date: ${invoiceDetails.issueDate}
Due Date: ${invoiceDetails.dueDate}
${itemText}Subtotal: $${formatMoney(invoiceDetails.subtotal)}
Tax: $${formatMoney(invoiceDetails.tax)}
Shipping: $${formatMoney(invoiceDetails.shipping)}
Total Amount: $${amount}
Payment Status: ${statusLabel}

If you have any questions, please contact our support team.

Best regards,
The PrintFlow Team
`;

  const itemRows = items.map((item) => `
        <tr>
          <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${item.name || 'Print item'}</td>
          <td style="padding: 6px 0; text-align: right; color: #1e293b; font-size: 14px;">${item.quantity || 1}</td>
          <td style="padding: 6px 0; text-align: right; color: #1e293b; font-size: 14px;">$${formatMoney(item.unitPrice)}</td>
          <td style="padding: 6px 0; text-align: right; color: #1e293b; font-size: 14px;">$${formatMoney(item.subtotal)}</td>
        </tr>`).join('');

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #3b82f6; border-radius: 12px; max-width: 550px; margin: auto; background-color: #ffffff;">
      <h2 style="color: #1e3a8a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">${isAdminCopy ? 'PrintFlow Invoice Copy' : 'PrintFlow Invoice'}</h2>
      <p style="color: #4b5563; font-size: 14px; line-height: 1.5;">
        ${isAdminCopy
          ? `${deliveredNote ? 'An order has been delivered. ' : ''}This is a copy of the customer invoice for your records. The invoice PDF is attached.`
          : `${deliveredNote ? 'Your order has been delivered. ' : ''}Please find your invoice details below. The invoice PDF is attached.`}
      </p>
      ${isAdminCopy && (invoiceDetails.customerName || invoiceDetails.customerEmail) ? `<p style="color: #1e293b; font-size: 14px;"><strong>Customer:</strong> ${invoiceDetails.customerName || 'Customer'}${invoiceDetails.customerEmail ? ` (${invoiceDetails.customerEmail})` : ''}</p>` : ''}
      <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Invoice Number:</td>
          <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${invoiceDetails.invoiceNumber}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Order Number:</td>
          <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${invoiceDetails.orderNumber}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Issue Date:</td>
          <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${invoiceDetails.issueDate}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Due Date:</td>
          <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${invoiceDetails.dueDate}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Status:</td>
          <td style="padding: 6px 0; font-size: 14px;">
            <span style="background-color: ${invoiceDetails.status === 'paid' ? '#def7ec' : '#fde8e8'}; color: ${invoiceDetails.status === 'paid' ? '#03543f' : '#9b1c1c'}; padding: 3px 8px; border-radius: 4px; font-weight: bold;">
              ${statusLabel}
            </span>
          </td>
        </tr>
      </table>
      ${items.length ? `
      <table style="width: 100%; border-collapse: collapse; margin-top: 18px;">
        <tr>
          <th style="text-align: left; padding: 6px 0; border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 12px;">Item</th>
          <th style="text-align: right; padding: 6px 0; border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 12px;">Qty</th>
          <th style="text-align: right; padding: 6px 0; border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 12px;">Price</th>
          <th style="text-align: right; padding: 6px 0; border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 12px;">Amount</th>
        </tr>
        ${itemRows}
      </table>` : ''}
      <table style="width: 100%; border-collapse: collapse; margin-top: 12px;">
        <tr>
          <td style="padding: 4px 0; color: #4b5563; font-size: 14px;">Subtotal</td>
          <td style="padding: 4px 0; text-align: right; color: #1e293b; font-size: 14px;">$${formatMoney(invoiceDetails.subtotal)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #4b5563; font-size: 14px;">Tax</td>
          <td style="padding: 4px 0; text-align: right; color: #1e293b; font-size: 14px;">$${formatMoney(invoiceDetails.tax)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #4b5563; font-size: 14px;">Shipping</td>
          <td style="padding: 4px 0; text-align: right; color: #1e293b; font-size: 14px;">$${formatMoney(invoiceDetails.shipping)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #1e3a8a; font-size: 15px;">Total</td>
          <td style="padding: 6px 0; text-align: right; font-weight: bold; color: #1e3a8a; font-size: 15px;">$${amount}</td>
        </tr>
      </table>
      <div style="margin-top: 25px; border-top: 1px solid #e5e7eb; padding-top: 15px; text-align: center;">
        <p style="font-size: 12px; color: #6b7280; margin: 0;">Thank you for your business!</p>
        <p style="font-size: 11px; color: #9ca3af; margin-top: 5px;">PrintFlow printing and design hub.</p>
      </div>
    </div>
  `;

  const subject = isAdminCopy
    ? `Invoice Copy: ${invoiceDetails.invoiceNumber} (${invoiceDetails.orderNumber})`
    : `Invoice Details: ${invoiceDetails.invoiceNumber}`;
  const recipientLabel = recipients.join(', ');
  const pdfBuffer = await renderInvoicePdf(invoiceDetails);
  const pdfName = `${String(invoiceDetails.invoiceNumber || 'invoice').replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[INVOICE EMAIL] Sent to ${recipientLabel}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write invoice text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #3b82f6; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${recipientLabel} | Subject: ${subject}
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write invoice HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Accounting" <${process.env.SMTP_USER || 'accounting@printflow.com'}>`,
    to: recipients,
    subject,
    text: emailText,
    html: emailHtml,
    attachments: [
      {
        filename: pdfName,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendLoginEmail = async (toEmail, fullName) => {
  const emailText = `
Hello ${fullName},

We noticed a successful login to your PrintFlow account just now.
If this was you, no further action is needed.

If you did not authorize this login, please contact support immediately.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #3b82f6;">New Login Alert</h2>
      <p>Hi ${fullName},</p>
      <p>We noticed a successful login to your PrintFlow account just now.</p>
      <p>If this was you, no further action is needed.</p>
      <p>If you did not authorize this login, please contact support immediately.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[LOGIN ALERT] Sent to ${toEmail}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write login alert text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #3b82f6; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Security Alert: New Login to Your Account
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write login alert HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Security" <${process.env.SMTP_USER || 'security@printflow.com'}>`,
    to: toEmail,
    subject: 'Security Alert: New Login to Your Account',
    text: emailText,
    html: emailHtml,
  });

  void Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

const sendAndLogEmail = async ({ to, subject, text, html, fromName = 'PrintFlow Team', borderColor = '#10b981' }) => {
  const recipients = splitRecipients(to);
  const toEmail = recipients.join(', ');
  if (!toEmail) {
    console.log(`[MAILER] Skipping "${subject}" — no recipient.`);
    return;
  }

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[${subject}] Sent to ${toEmail}\n${text}\n`)
    .catch((err) => console.error('[MAILER] Failed to write text log:', err));

  const htmlEntry = `
<div style="border: 2px solid ${borderColor}; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: ${subject}
  </div>
  ${html}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"${fromName}" <${process.env.SMTP_USER || 'noreply@printflow.com'}>`,
    to: recipients,
    subject,
    text,
    html,
  });

  await Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

const formatMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
};

const orderItemsSummary = (orderDetails = {}) => {
  const items = Array.isArray(orderDetails.items) ? orderDetails.items : [];
  if (items.length === 0) return 'See your account for item details.';
  return items.map((item) => {
    const name = item.product?.name || item.name || 'Print item';
    return `${name} × ${item.quantity || 1}`;
  }).join(', ');
};

export const sendOrderConfirmationEmail = async (toEmail, fullName, orderDetails) => {
  const emailText = `
Hello ${fullName},

Thank you for your order!
Your order ${orderDetails.orderNumber} has been placed successfully.

Total Amount: $${formatMoney(orderDetails.total)}

You can view your order details by logging into your account.

Best regards,
The PrintFlow Team
`;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #10b981; border-radius: 12px; max-width: 550px; margin: auto; background-color: #ffffff;">
      <h2 style="color: #059669; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">Order Confirmation</h2>
      <p>Hi ${fullName},</p>
      <p>Thank you for your order! Your order <strong>${orderDetails.orderNumber}</strong> has been placed successfully.</p>
      <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
        <tr>
          <td style="padding: 6px 0; font-weight: bold; color: #4b5563; font-size: 14px;">Total Amount:</td>
          <td style="padding: 6px 0; font-weight: bold; color: #059669; font-size: 15px;">$${formatMoney(orderDetails.total)}</td>
        </tr>
      </table>
      <p style="margin-top: 20px;">You can view your full order details by logging into your account.</p>
      <div style="margin-top: 25px; border-top: 1px solid #e5e7eb; padding-top: 15px; text-align: center;">
        <p style="font-size: 11px; color: #9ca3af; margin-top: 5px;">PrintFlow printing and design hub.</p>
      </div>
    </div>
  `;

  const logFilePath = path.join(__dirname, '..', 'email-log.txt');
  const htmlLogFilePath = path.join(__dirname, '..', 'email-log.html');

  const logPromise = fs.promises.appendFile(logFilePath, `\n[ORDER CONFIRMATION] Sent to ${toEmail}\n${emailText}\n`)
    .catch((err) => console.error('[MAILER] Failed to write order confirmation text log:', err));

  const htmlEntry = `
<div style="border: 2px solid #10b981; border-radius: 8px; margin-bottom: 20px; padding: 15px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: bold; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; font-size: 13px;">
    Timestamp: ${new Date().toISOString()} | To: ${toEmail} | Subject: Order Confirmation: ${orderDetails.orderNumber}
  </div>
  ${emailHtml}
</div>
`;

  const htmlLogPromise = fs.promises.appendFile(htmlLogFilePath, htmlEntry)
    .catch((err) => console.error('[MAILER] Failed to write order confirmation HTML log:', err));

  const smtpPromise = sendMailWithSmtp({
    from: `"PrintFlow Orders" <${process.env.SMTP_USER || 'orders@printflow.com'}>`,
    to: toEmail,
    subject: `Order Confirmation: ${orderDetails.orderNumber}`,
    text: emailText,
    html: emailHtml,
  });

  void Promise.allSettled([logPromise, htmlLogPromise, smtpPromise]);
};

export const sendOrderPlacedEmails = async ({ customerEmail, customerName, adminEmails = [], orderDetails }) => {
  const orderNumber = orderDetails.orderNumber;
  const total = formatMoney(orderDetails.total);
  const items = orderItemsSummary(orderDetails);
  const status = (orderDetails.status || 'pending').replace(/_/g, ' ');

  await sendAndLogEmail({
    to: customerEmail,
    subject: `Order Confirmation: ${orderNumber}`,
    fromName: 'PrintFlow Orders',
    text: `Hello ${customerName || 'Customer'},\n\nThank you for your order ${orderNumber}.\nStatus: ${status}\nItems: ${items}\nTotal: $${total}\n\nWe will email you at each step as your order moves through production and delivery.\n\nThe PrintFlow Team\n`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #10b981; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #059669;">Order Confirmed</h2>
        <p>Hi ${customerName || 'Customer'},</p>
        <p>Your order <strong>${orderNumber}</strong> has been placed successfully.</p>
        <p><strong>Status:</strong> ${status}<br/><strong>Items:</strong> ${items}<br/><strong>Total:</strong> $${total}</p>
        <p>We will email you at each fulfillment step.</p>
        <p>Best regards,<br/>The PrintFlow Team</p>
      </div>
    `,
  });

  await sendAndLogEmail({
    to: adminEmails,
    subject: `New Order Placed: ${orderNumber}`,
    fromName: 'PrintFlow Orders',
    borderColor: '#2563eb',
    text: `A new order was placed.\n\nOrder: ${orderNumber}\nCustomer: ${customerName} (${customerEmail})\nItems: ${items}\nTotal: $${total}\nStatus: ${status}\n`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #2563eb; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #1e3a8a;">New Order Received</h2>
        <p><strong>Order:</strong> ${orderNumber}</p>
        <p><strong>Customer:</strong> ${customerName} (${customerEmail})</p>
        <p><strong>Items:</strong> ${items}</p>
        <p><strong>Total:</strong> $${total}</p>
        <p><strong>Status:</strong> ${status}</p>
      </div>
    `,
  });
};

export const sendOrderStatusEmails = async ({ customerEmail, customerName, adminEmails = [], orderDetails, previousStatus, newStatus, extraNote }) => {
  const orderNumber = orderDetails.orderNumber;
  const total = formatMoney(orderDetails.total);
  const items = orderItemsSummary(orderDetails);
  const statusLabel = String(newStatus || '').replace(/_/g, ' ');

  await sendAndLogEmail({
    to: customerEmail,
    subject: `Order Update: ${orderNumber} is now ${statusLabel}`,
    fromName: 'PrintFlow Orders',
    borderColor: '#f59e0b',
    text: `Hello ${customerName || 'Customer'},\n\nYour order ${orderNumber} status is now: ${statusLabel}.${previousStatus ? `\nPrevious status: ${previousStatus}` : ''}\nItems: ${items}\nTotal: $${total}${extraNote ? `\nNote: ${extraNote}` : ''}\n\nThe PrintFlow Team\n`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #f59e0b; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #b45309;">Order Status Update</h2>
        <p>Hi ${customerName || 'Customer'},</p>
        <p>Your order <strong>${orderNumber}</strong> is now <strong>${statusLabel}</strong>.</p>
        <p><strong>Items:</strong> ${items}<br/><strong>Total:</strong> $${total}</p>
        ${extraNote ? `<p>${extraNote}</p>` : ''}
        <p>Best regards,<br/>The PrintFlow Team</p>
      </div>
    `,
  });

  await sendAndLogEmail({
    to: adminEmails,
    subject: `Order ${orderNumber} updated to ${statusLabel}`,
    fromName: 'PrintFlow Orders',
    borderColor: '#2563eb',
    text: `Order ${orderNumber} for ${customerName} (${customerEmail}) is now ${statusLabel}.${previousStatus ? `\nPrevious status: ${previousStatus}` : ''}\nItems: ${items}\nTotal: $${total}${extraNote ? `\nNote: ${extraNote}` : ''}\n`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #2563eb; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #1e3a8a;">Admin Order Update</h2>
        <p><strong>Order:</strong> ${orderNumber}</p>
        <p><strong>Customer:</strong> ${customerName} (${customerEmail})</p>
        <p><strong>New status:</strong> ${statusLabel}</p>
        ${previousStatus ? `<p><strong>Previous status:</strong> ${previousStatus}</p>` : ''}
        <p><strong>Items:</strong> ${items}</p>
        ${extraNote ? `<p>${extraNote}</p>` : ''}
      </div>
    `,
  });
};

export const sendLowStockAlertEmail = async ({ adminEmails = [], productName, sku, quantityAvailable, reorderPoint, warehouseLocation }) => {
  const subject = `PrintFlow: please restock ${productName || sku || 'a product'}`;
  const emailText = `
Hello,

PrintFlow inventory is running low and needs to be increased.

Product: ${productName || 'Unknown'}
SKU: ${sku || 'N/A'}
Quantity available: ${quantityAvailable}
Reorder point: ${reorderPoint}
Warehouse: ${warehouseLocation || 'N/A'}

Please increase the quantity as soon as possible.

Best regards,
The PrintFlow Team
`;
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px; margin: auto;">
      <h2 style="color: #b91c1c;">Inventory Needs Restocking</h2>
      <p>PrintFlow inventory is running low and needs to be increased.</p>
      <p><strong>Product:</strong> ${productName || 'Unknown'}<br/>
      <strong>SKU:</strong> ${sku || 'N/A'}<br/>
      <strong>Quantity available:</strong> ${quantityAvailable}<br/>
      <strong>Reorder point:</strong> ${reorderPoint}<br/>
      <strong>Warehouse:</strong> ${warehouseLocation || 'N/A'}</p>
      <p>Please increase the quantity as soon as possible.</p>
      <br/>
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  await sendAndLogEmail({
    to: adminEmails,
    subject,
    fromName: 'PrintFlow Team',
    borderColor: '#dc2626',
    text: emailText,
    html: emailHtml,
  });
};

export const sendStockOrderEmail = async ({
  recipients = [],
  productName,
  sku,
  quantityAvailable,
  reorderPoint,
  warehouseLocation,
  orderQuantity,
  note,
  requestedBy,
}) => {
  const subject = `PrintFlow stock order: ${productName || sku || 'inventory item'}`;
  const noteLine = note ? `\nNote: ${note}` : '';
  const emailText = `
Hello,

Please order stock for the item below.

Product: ${productName || 'Unknown'}
SKU: ${sku || 'N/A'}
Quantity to order: ${orderQuantity}
Quantity currently available: ${quantityAvailable}
Reorder point: ${reorderPoint}
Warehouse: ${warehouseLocation || 'N/A'}
Requested by: ${requestedBy || 'PrintFlow admin'}${noteLine}

Best regards,
The PrintFlow Team
`;
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 520px; margin: auto;">
      <h2 style="color: #1d4ed8;">Stock Order Request</h2>
      <p>Please order the following stock.</p>
      <p><strong>Product:</strong> ${productName || 'Unknown'}<br/>
      <strong>SKU:</strong> ${sku || 'N/A'}<br/>
      <strong>Quantity to order:</strong> ${orderQuantity}<br/>
      <strong>Quantity currently available:</strong> ${quantityAvailable}<br/>
      <strong>Reorder point:</strong> ${reorderPoint}<br/>
      <strong>Warehouse:</strong> ${warehouseLocation || 'N/A'}<br/>
      <strong>Requested by:</strong> ${requestedBy || 'PrintFlow admin'}</p>
      ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
      <p>Best regards,<br/>The PrintFlow Team</p>
    </div>
  `;

  await sendAndLogEmail({
    to: recipients,
    subject,
    fromName: 'PrintFlow Inventory',
    borderColor: '#2563eb',
    text: emailText,
    html: emailHtml,
  });
};



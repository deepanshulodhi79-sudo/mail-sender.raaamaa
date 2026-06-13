const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ─── Upload folder ───────────────────────────────────────────
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + "-" + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── In-memory store ──────────────────────────────────────────
const mailHistory = [];
const mailQueue = [];
let isProcessingQueue = false;

// ─── Rate Limiting ────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { success: false, error: "Too many requests. Please wait 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/send-mail", limiter);
app.use("/queue-mail", limiter);

// ─── Parse recipients (comma or newline separated) ────────────
function parseRecipients(str) {
  if (!str) return "";
  return str
    .split(/[\n,]+/)
    .map(e => e.trim())
    .filter(Boolean)
    .join(", ");
}

// ─── Build transporter ────────────────────────────────────────
function buildTransporter(senderEmail, appPassword, provider = "gmail") {
  const configs = {
    gmail: {
      service: "gmail",
      auth: { user: senderEmail, pass: appPassword },
    },
    outlook: {
      host: "smtp-mail.outlook.com",
      port: 587,
      secure: false,
      auth: { user: senderEmail, pass: appPassword },
      tls: { ciphers: "SSLv3" },
    },
    yahoo: {
      service: "yahoo",
      auth: { user: senderEmail, pass: appPassword },
    },
  };
  return nodemailer.createTransport(configs[provider] || configs.gmail);
}

// ─── Core send ────────────────────────────────────────────────
async function doSendMail(job) {
  const {
    senderEmail, senderName, appPassword, provider,
    toEmail, ccEmail, bccEmail,
    subject, htmlBody, attachments,
  } = job;

  const transporter = buildTransporter(senderEmail, appPassword, provider);

  // Anti-spam: proper from with real name, message-id, date headers
  const displayName = senderName ? senderName : senderEmail.split("@")[0];
  const domain = senderEmail.split("@")[1] || "mail.com";

  const mailOptions = {
    from: `"${displayName}" <${senderEmail}>`,
    to: parseRecipients(toEmail),
    subject,
    html: htmlBody,
    text: htmlBody.replace(/<[^>]+>/g, ""), // plain-text fallback (important for spam)
    headers: {
      "X-Mailer": "Mail-Pro/2.0",
      "Message-ID": `<${uuidv4()}@${domain}>`,
      "Date": new Date().toUTCString(),
      "MIME-Version": "1.0",
      "List-Unsubscribe": `<mailto:${senderEmail}?subject=unsubscribe>`,
    },
    priority: "normal",
  };

  if (ccEmail && ccEmail.trim()) mailOptions.cc = parseRecipients(ccEmail);
  if (bccEmail && bccEmail.trim()) mailOptions.bcc = parseRecipients(bccEmail);

  if (attachments && attachments.length > 0) {
    mailOptions.attachments = attachments.map((f) => ({
      filename: f.originalname,
      path: f.path,
    }));
  }

  const info = await transporter.sendMail(mailOptions);

  // Cleanup
  if (attachments) {
    attachments.forEach((f) => {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    });
  }
  return info;
}

// ─── Queue Processor ──────────────────────────────────────────
async function processQueue() {
  if (isProcessingQueue || mailQueue.length === 0) return;
  isProcessingQueue = true;
  while (mailQueue.length > 0) {
    const job = mailQueue[0];
    job.status = "sending";
    const histItem = mailHistory.find(h => h.id === job.id);
    if (histItem) histItem.status = "sending";
    try {
      await doSendMail(job);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
      if (histItem) { histItem.status = "sent"; histItem.sentAt = job.sentAt; }
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      if (histItem) { histItem.status = "failed"; histItem.error = err.message; }
    }
    mailQueue.shift();
    await new Promise((r) => setTimeout(r, 1000));
  }
  isProcessingQueue = false;
}

// ─── Routes ───────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", queued: mailQueue.length, history: mailHistory.length })
);

app.post("/send-mail", upload.array("attachments", 5), async (req, res) => {
  const { senderEmail, senderName, appPassword, provider, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;
  if (!senderEmail || !appPassword || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const id = uuidv4();
  const record = {
    id, senderEmail, senderName, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject,
    sentAt: new Date().toISOString(), status: "sending",
    attachmentCount: req.files ? req.files.length : 0,
  };
  mailHistory.unshift(record);
  if (mailHistory.length > 100) mailHistory.pop();

  try {
    await doSendMail({
      senderEmail, senderName, appPassword, provider: provider || "gmail",
      toEmail, ccEmail, bccEmail, subject, htmlBody,
      attachments: req.files || [],
    });
    record.status = "sent";
    res.json({ success: true, message: "✅ Mail bhej diya gaya!", id });
  } catch (err) {
    record.status = "failed";
    record.error = err.message;
    res.status(500).json({ success: false, error: "❌ " + err.message });
  }
});

app.post("/queue-mail", upload.array("attachments", 5), (req, res) => {
  const { senderEmail, senderName, appPassword, provider, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;
  if (!senderEmail || !appPassword || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const id = uuidv4();
  const job = {
    id, senderEmail, senderName, appPassword, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject, htmlBody,
    attachments: req.files || [], status: "queued",
    queuedAt: new Date().toISOString(),
  };
  mailQueue.push(job);
  mailHistory.unshift({
    id, senderEmail, senderName, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject,
    sentAt: null, status: "queued",
    attachmentCount: req.files ? req.files.length : 0,
  });
  if (mailHistory.length > 100) mailHistory.pop();
  processQueue();
  res.json({ success: true, message: `📬 Queue mein add! Position: ${mailQueue.length}`, id });
});

app.get("/history", (req, res) => res.json({ success: true, history: mailHistory }));
app.get("/queue-status", (req, res) =>
  res.json({ success: true, queued: mailQueue.length, processing: isProcessingQueue })
);
app.delete("/history/:id", (req, res) => {
  const idx = mailHistory.findIndex((h) => h.id === req.params.id);
  if (idx !== -1) mailHistory.splice(idx, 1);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Mail Pro running on port ${PORT}`));

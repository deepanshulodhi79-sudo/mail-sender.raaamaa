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
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

// ─── In-memory mail history & queue ──────────────────────────
const mailHistory = [];
const mailQueue = [];
let isProcessingQueue = false;

// ─── Rate Limiting ────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 10,                   // max 10 requests per minute per IP
  message: { success: false, error: "Too many requests. Please wait 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/send-mail", limiter);
app.use("/queue-mail", limiter);

// ─── Build transporter based on provider ─────────────────────
function buildTransporter(senderEmail, appPassword, provider = "gmail") {
  const configs = {
    gmail: { service: "gmail", auth: { user: senderEmail, pass: appPassword } },
    outlook: {
      host: "smtp-mail.outlook.com",
      port: 587,
      secure: false,
      auth: { user: senderEmail, pass: appPassword },
      tls: { ciphers: "SSLv3" },
    },
    yahoo: { service: "yahoo", auth: { user: senderEmail, pass: appPassword } },
  };
  return nodemailer.createTransport(configs[provider] || configs.gmail);
}

// ─── Core send function ───────────────────────────────────────
async function doSendMail(job) {
  const {
    senderEmail, appPassword, provider,
    toEmail, ccEmail, bccEmail,
    subject, htmlBody, attachments,
  } = job;

  const transporter = buildTransporter(senderEmail, appPassword, provider);

  const mailOptions = {
    from: `"Mail Pro" <${senderEmail}>`,
    to: toEmail,
    subject,
    html: htmlBody,
  };

  if (ccEmail && ccEmail.trim()) mailOptions.cc = ccEmail;
  if (bccEmail && bccEmail.trim()) mailOptions.bcc = bccEmail;

  if (attachments && attachments.length > 0) {
    mailOptions.attachments = attachments.map((f) => ({
      filename: f.originalname,
      path: f.path,
    }));
  }

  await transporter.sendMail(mailOptions);

  // Cleanup temp attachments
  if (attachments) {
    attachments.forEach((f) => {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    });
  }
}

// ─── Queue Processor ──────────────────────────────────────────
async function processQueue() {
  if (isProcessingQueue || mailQueue.length === 0) return;
  isProcessingQueue = true;

  while (mailQueue.length > 0) {
    const job = mailQueue[0];
    job.status = "sending";

    try {
      await doSendMail(job);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
    }

    mailQueue.shift();
    await new Promise((r) => setTimeout(r, 800)); // small delay between mails
  }

  isProcessingQueue = false;
}

// ─── Routes ───────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", queued: mailQueue.length, history: mailHistory.length }));

// Send immediately
app.post("/send-mail", upload.array("attachments", 5), async (req, res) => {
  const { senderEmail, appPassword, provider, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;

  if (!senderEmail || !appPassword || !toEmail || !subject || !htmlBody) {
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });
  }

  const id = uuidv4();
  const record = {
    id, senderEmail, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject,
    sentAt: new Date().toISOString(),
    status: "sending",
    attachmentCount: req.files ? req.files.length : 0,
  };
  mailHistory.unshift(record);
  if (mailHistory.length > 100) mailHistory.pop();

  try {
    await doSendMail({
      senderEmail, appPassword, provider: provider || "gmail",
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

// Add to queue
app.post("/queue-mail", upload.array("attachments", 5), (req, res) => {
  const { senderEmail, appPassword, provider, toEmail, ccEmail, bccEmail, subject, htmlBody, scheduledAt } = req.body;

  if (!senderEmail || !appPassword || !toEmail || !subject || !htmlBody) {
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });
  }

  const id = uuidv4();
  const job = {
    id, senderEmail, appPassword, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject, htmlBody,
    attachments: req.files || [],
    status: "queued",
    queuedAt: new Date().toISOString(),
    scheduledAt: scheduledAt || null,
  };

  mailQueue.push(job);
  mailHistory.unshift({
    id, senderEmail, provider: provider || "gmail",
    toEmail, ccEmail, bccEmail, subject,
    sentAt: null,
    status: "queued",
    attachmentCount: req.files ? req.files.length : 0,
  });
  if (mailHistory.length > 100) mailHistory.pop();

  processQueue();
  res.json({ success: true, message: `📬 Mail queue mein add ho gaya! Position: ${mailQueue.length}`, id });
});

// Get history
app.get("/history", (req, res) => {
  res.json({ success: true, history: mailHistory });
});

// Queue status
app.get("/queue-status", (req, res) => {
  res.json({ success: true, queued: mailQueue.length, processing: isProcessingQueue });
});

// Delete history entry
app.delete("/history/:id", (req, res) => {
  const idx = mailHistory.findIndex((h) => h.id === req.params.id);
  if (idx !== -1) mailHistory.splice(idx, 1);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Mail Pro server running on port ${PORT}`));

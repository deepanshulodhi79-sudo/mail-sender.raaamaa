const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.set("trust proxy", 1);
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
  max: 20,
  message: { success: false, error: "Too many requests. Please wait 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/send-mail", limiter);
app.use("/queue-mail", limiter);

// ─── Brevo SMTP config ────────────────────────────────────────
const BREVO = {
  host: "smtp-relay.brevo.com",
  port: 587,
  user: "aea29a001@smtp-brevo.com",
  pass: "GkBWtbZ7ANxr1MY8",
};

// ─── Transporter — Brevo SMTP ─────────────────────────────────
function buildTransporter() {
  return nodemailer.createTransport({
    host: BREVO.host,
    port: BREVO.port,
    secure: false,
    auth: {
      user: BREVO.user,
      pass: BREVO.pass,
    },
  });
}

// ─── Parse recipients → clean email array ────────────────────
function parseRecipients(str) {
  if (!str) return [];
  return str
    .split(/[\n,]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes("@"));
}

// ─── Send ONE mail to ONE recipient ──────────────────────────
async function sendToOne(transporter, {
  senderEmail, senderName, domain,
  recipient, ccList, bccList,
  subject, htmlBody, attachments,
}) {
  const displayName = senderName || "ClientBoost";

  const mailOptions = {
    from: `"${displayName}" <${senderEmail}>`,   // e.g. "Rahul" <hello@clientboost.in>
    to: recipient,
    replyTo: senderEmail,
    subject,
    html: htmlBody,
    text: htmlBody.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    headers: {
      "Message-ID": `<${uuidv4()}@${domain}>`,
      "Date": new Date().toUTCString(),
    },
    encoding: "utf-8",
  };

  if (ccList && ccList.length) mailOptions.cc = ccList.join(", ");
  if (bccList && bccList.length) mailOptions.bcc = bccList.join(", ");

  if (attachments && attachments.length > 0) {
    mailOptions.attachments = attachments.map(f => ({
      filename: f.originalname,
      path: f.path,
    }));
  }

  return transporter.sendMail(mailOptions);
}

// ─── Send to ALL recipients individually ─────────────────────
async function doSendMail(job) {
  const {
    senderEmail, senderName,
    toEmail, ccEmail, bccEmail,
    subject, htmlBody, attachments,
  } = job;

  const transporter = buildTransporter();
  const domain = "clientboost.in";

  const toList  = parseRecipients(toEmail);
  const ccList  = parseRecipients(ccEmail);
  const bccList = parseRecipients(bccEmail);

  if (toList.length === 0) throw new Error("Koi valid email address nahi mila.");

  const results = { sent: [], failed: [] };

  for (const recipient of toList) {
    try {
      await sendToOne(transporter, {
        senderEmail, senderName, domain,
        recipient, ccList, bccList,
        subject, htmlBody, attachments,
      });
      results.sent.push(recipient);
      if (toList.length > 1) await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      results.failed.push({ email: recipient, error: err.message });
    }
  }

  // Cleanup attachments
  if (attachments) {
    attachments.forEach(f => {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    });
  }

  return results;
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
      const results = await doSendMail(job);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
      if (histItem) {
        histItem.status = "sent";
        histItem.sentAt = job.sentAt;
        histItem.sentCount = results.sent.length;
        histItem.failedCount = results.failed.length;
      }
    } catch (err) {
      job.status = "failed";
      if (histItem) { histItem.status = "failed"; histItem.error = err.message; }
    }
    mailQueue.shift();
    await new Promise(r => setTimeout(r, 800));
  }
  isProcessingQueue = false;
}

// ─── Routes ───────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", queued: mailQueue.length, history: mailHistory.length })
);

app.post("/send-mail", upload.array("attachments", 5), async (req, res) => {
  const { senderEmail, senderName, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;

  if (!senderEmail || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const toList = parseRecipients(toEmail);
  if (toList.length === 0)
    return res.status(400).json({ success: false, error: "Koi valid email nahi mila To field mein." });

  const id = uuidv4();
  const record = {
    id, senderEmail, senderName,
    toEmail, subject,
    sentAt: new Date().toISOString(),
    status: "sending",
    totalRecipients: toList.length,
    attachmentCount: req.files ? req.files.length : 0,
  };
  mailHistory.unshift(record);
  if (mailHistory.length > 200) mailHistory.pop();

  try {
    const results = await doSendMail({
      senderEmail, senderName,
      toEmail, ccEmail, bccEmail,
      subject, htmlBody,
      attachments: req.files || [],
    });

    record.status = results.failed.length === 0 ? "sent" : "partial";
    record.sentCount = results.sent.length;
    record.failedCount = results.failed.length;

    const msg = results.failed.length === 0
      ? `✅ Sabhi ${results.sent.length} log ko alag-alag mail bhej diya!`
      : `⚠️ ${results.sent.length} sent, ${results.failed.length} failed.`;

    res.json({ success: true, message: msg, results, id });
  } catch (err) {
    record.status = "failed";
    res.status(500).json({ success: false, error: "❌ " + err.message });
  }
});

app.post("/queue-mail", upload.array("attachments", 5), (req, res) => {
  const { senderEmail, senderName, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;

  if (!senderEmail || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const toList = parseRecipients(toEmail);
  const id = uuidv4();
  const job = {
    id, senderEmail, senderName,
    toEmail, ccEmail, bccEmail,
    subject, htmlBody,
    attachments: req.files || [],
    status: "queued",
    queuedAt: new Date().toISOString(),
    totalRecipients: toList.length,
  };
  mailQueue.push(job);
  mailHistory.unshift({
    id, senderEmail, senderName,
    toEmail, subject,
    sentAt: null, status: "queued",
    totalRecipients: toList.length,
    attachmentCount: req.files ? req.files.length : 0,
  });
  if (mailHistory.length > 200) mailHistory.pop();
  processQueue();
  res.json({
    success: true,
    message: `📬 ${toList.length} recipient(s) queue mein add! Position: ${mailQueue.length}`,
    id,
  });
});

app.get("/history", (req, res) => res.json({ success: true, history: mailHistory }));
app.get("/queue-status", (req, res) =>
  res.json({ success: true, queued: mailQueue.length, processing: isProcessingQueue })
);
app.delete("/history/:id", (req, res) => {
  const idx = mailHistory.findIndex(h => h.id === req.params.id);
  if (idx !== -1) mailHistory.splice(idx, 1);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Mail Pro running on port ${PORT}`));

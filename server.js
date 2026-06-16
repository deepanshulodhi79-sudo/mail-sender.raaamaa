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

// ─── Uploads ──────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, uuidv4() + "-" + file.originalname),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─── In-memory store ──────────────────────────────────────────
const mailHistory = [];
const mailQueue   = [];
let isProcessingQueue = false;

// ─── Rate limit ───────────────────────────────────────────────
app.use(["/send-mail", "/queue-mail"], rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. 1 minute baad try karo." },
}));

// ─── Brevo transporter ────────────────────────────────────────
function makeTransporter() {
  return nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: {
      user: "aea29a001@smtp-brevo.com",
      pass: "xsmtpsib-c96aa4f6cd79e22c68cba95fe8f2d1d479361852212f9277b8b9456b66a23941-vIDDWHrbJqiYFBOb",
    },
  });
}

// ─── Parse emails (line/comma separated) ─────────────────────
function parseEmails(str) {
  if (!str) return [];
  return str.split(/[\n,]+/).map(e => e.trim()).filter(e => e.includes("@"));
}

// ─── Send one email to one recipient ─────────────────────────
async function sendOne(transporter, { senderName, senderEmail, to, cc, bcc, subject, html }) {
  const name = senderName || "ClientBoost";
  await transporter.sendMail({
    from:    `"${name}" <${senderEmail}>`,
    to,
    cc:      cc.length  ? cc.join(",")  : undefined,
    bcc:     bcc.length ? bcc.join(",") : undefined,
    subject,
    html,
    text: html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    headers: {
      "Message-ID": `<${uuidv4()}@clientboost.in>`,
    },
  });
}

// ─── Send to all recipients one by one ───────────────────────
async function sendAll(job) {
  const { senderName, senderEmail, toEmail, ccEmail, bccEmail, subject, htmlBody, attachments } = job;

  const toList  = parseEmails(toEmail);
  const ccList  = parseEmails(ccEmail);
  const bccList = parseEmails(bccEmail);

  if (!toList.length) throw new Error("Koi valid To email nahi mila.");

  // Verify transporter first
  const transporter = makeTransporter();
  await transporter.verify();

  const sent   = [];
  const failed = [];

  for (const to of toList) {
    try {
      await sendOne(transporter, { senderName, senderEmail, to, cc: ccList, bcc: bccList, subject, html: htmlBody });
      sent.push(to);
      console.log(`✅ Sent to: ${to}`);
      if (toList.length > 1) await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      failed.push({ email: to, error: err.message });
      console.error(`❌ Failed: ${to} — ${err.message}`);
    }
  }

  // Cleanup attachments
  (attachments || []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

  return { sent, failed };
}

// ─── Queue processor ──────────────────────────────────────────
async function processQueue() {
  if (isProcessingQueue || !mailQueue.length) return;
  isProcessingQueue = true;
  while (mailQueue.length) {
    const job = mailQueue[0];
    const hist = mailHistory.find(h => h.id === job.id);
    try {
      if (hist) hist.status = "sending";
      const r = await sendAll(job);
      if (hist) { hist.status = "sent"; hist.sentAt = new Date().toISOString(); hist.sentCount = r.sent.length; hist.failedCount = r.failed.length; }
    } catch (err) {
      if (hist) { hist.status = "failed"; hist.error = err.message; }
    }
    mailQueue.shift();
    await new Promise(r => setTimeout(r, 500));
  }
  isProcessingQueue = false;
}

// ─── Routes ───────────────────────────────────────────────────

app.get("/health", (req, res) =>
  res.json({ status: "ok", queued: mailQueue.length, history: mailHistory.length })
);

// Send now
app.post("/send-mail", upload.array("attachments", 5), async (req, res) => {
  const { senderEmail, senderName, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;

  console.log("📨 Send request:", { senderEmail, toEmail, subject });

  if (!senderEmail || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const id = uuidv4();
  const record = { id, senderName, senderEmail, toEmail, subject, sentAt: new Date().toISOString(), status: "sending", attachmentCount: req.files?.length || 0 };
  mailHistory.unshift(record);
  if (mailHistory.length > 200) mailHistory.pop();

  try {
    const results = await sendAll({ senderName, senderEmail, toEmail, ccEmail, bccEmail, subject, htmlBody, attachments: req.files || [] });
    record.status     = results.failed.length === 0 ? "sent" : "partial";
    record.sentCount  = results.sent.length;
    record.failedCount = results.failed.length;

    const msg = results.failed.length === 0
      ? `✅ ${results.sent.length} log ko successfully mail bhej diya!`
      : `⚠️ ${results.sent.length} sent, ${results.failed.length} failed: ${results.failed.map(f => f.error).join(", ")}`;

    res.json({ success: true, message: msg, results });
  } catch (err) {
    console.error("Send error:", err.message);
    record.status = "failed";
    record.error  = err.message;
    res.status(500).json({ success: false, error: "❌ " + err.message });
  }
});

// Queue
app.post("/queue-mail", upload.array("attachments", 5), (req, res) => {
  const { senderEmail, senderName, toEmail, ccEmail, bccEmail, subject, htmlBody } = req.body;

  if (!senderEmail || !toEmail || !subject || !htmlBody)
    return res.status(400).json({ success: false, error: "Zaroori fields missing hain." });

  const toList = parseEmails(toEmail);
  const id = uuidv4();
  mailQueue.push({ id, senderName, senderEmail, toEmail, ccEmail, bccEmail, subject, htmlBody, attachments: req.files || [] });
  mailHistory.unshift({ id, senderName, senderEmail, toEmail, subject, sentAt: null, status: "queued", totalRecipients: toList.length, attachmentCount: req.files?.length || 0 });
  if (mailHistory.length > 200) mailHistory.pop();
  processQueue();
  res.json({ success: true, message: `📬 ${toList.length} recipient(s) queue mein add!` });
});

app.get("/history",      (req, res) => res.json({ success: true, history: mailHistory }));
app.get("/queue-status", (req, res) => res.json({ success: true, queued: mailQueue.length, processing: isProcessingQueue }));
app.delete("/history/:id", (req, res) => {
  const i = mailHistory.findIndex(h => h.id === req.params.id);
  if (i !== -1) mailHistory.splice(i, 1);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Mail Pro running on port ${PORT}`));

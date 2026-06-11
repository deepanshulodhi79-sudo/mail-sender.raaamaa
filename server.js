const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ✅ Health check (Northflank ke liye)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ✅ Mail send route
app.post("/send-mail", async (req, res) => {
  const { senderEmail, appPassword, toEmail, subject, message } = req.body;

  if (!senderEmail || !appPassword || !toEmail || !subject || !message) {
    return res.status(400).json({ success: false, error: "Sabhi fields bharna zaroori hai." });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: senderEmail,
        pass: appPassword,
      },
    });

    await transporter.sendMail({
      from: `"Mail Sender" <${senderEmail}>`,
      to: toEmail,
      subject: subject,
      text: message,
      html: `<p>${message.replace(/\n/g, "<br>")}</p>`,
    });

    res.json({ success: true, message: "✅ Mail successfully bhej diya gaya!" });
  } catch (err) {
    console.error("Mail error:", err.message);
    res.status(500).json({
      success: false,
      error: "❌ Mail nahi bheja ja saka: " + err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server chal raha hai port ${PORT} par`);
});

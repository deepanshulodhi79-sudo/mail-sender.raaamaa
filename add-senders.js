// Ye script server start hone par automatically run hogi
// Brevo mein sab senders add karegi

const https = require("https");

const API_KEY = "xsmtpsib-c96aa4f6cd79e22c68cba95fe8f2d1d479361852212f9277b8b9456b66a23941-vIDDWHrbJqiYFBOb";

const emails = [
  "hello","info","support","sales","contact",
  "admin","team","business","marketing","service",
  "help","enquiry","work","office","mail",
  "connect","network","growth","boost","client",
  "partner","media","outreach","digital","agency"
];

function addSender(email) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      name: "ClientBoost",
      email: `${email}@clientboost.in`
    });
    const options = {
      hostname: "api.brevo.com",
      path: "/v3/senders",
      method: "POST",
      headers: {
        "api-key": API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(data);
          if (r.id) console.log(`✅ Added: ${email}@clientboost.in`);
          else console.log(`⚠️  ${email}@clientboost.in — ${r.message||JSON.stringify(r)}`);
        } catch(e) {}
        resolve();
      });
    });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

async function addAllSenders() {
  console.log("🚀 Adding senders to Brevo...");
  for (const email of emails) {
    await addSender(email);
    await new Promise(r => setTimeout(r, 600));
  }
  console.log("✅ All senders processed!");
}

module.exports = { addAllSenders };

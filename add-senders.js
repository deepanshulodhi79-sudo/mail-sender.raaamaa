const https = require("https");

const API_KEY = "xsmtpsib-c96aa4f6cd79e22c68cba95fe8f2d1d479361852212f9277b8b9456b66a23941-vIDDWHrbJqiYFBOb";
const DOMAIN = "clientboost.in";

const emails = [
  // Already exist
  "hello","info","support","sales","contact",
  "admin","team","business","marketing","service",
  "help","enquiry","work","office","mail",
  "connect","network","growth","boost","client",
  "partner","media","outreach","digital","agency",
  // New 75
  "noreply","newsletter","updates","news","offers",
  "deals","promo","invite","welcome","notify",
  "alerts","reply","care","success","onboard",
  "billing","invoice","orders","payments","account",
  "verify","confirm","secure","privacy","legal",
  "press","jobs","careers","hire","recruit",
  "events","webinar","training","learn","edu",
  "consult","advisory","strategy","ideas","projects",
  "dev","tech","it","ops","systems",
  "brand","creative","design","content","social",
  "seo","ads","campaign","leads","crm",
  "research","data","reports","insights","analytics",
  "feedback","survey","review","ratings","quality",
  "vendor","supply","procurement","logistics","shipping",
  "export","import","global","international","india",
  "north","south","east","west","central",
  "retail","wholesale","enterprise","startup","smb",
  "vip","premium","pro","elite","plus"
];

async function addToImprovMX(alias) {
  return new Promise((resolve) => {
    // ImprovMX API
    const body = JSON.stringify({
      alias,
      forward: "raydyawear@gmail.com"
    });
    const encoded = Buffer.from(`api:${process.env.IMPROVMX_KEY||"sk_508330bd414c48e7817da35d838436ad"}`).toString("base64");
    const req = https.request({
      hostname: "api.improvmx.com",
      path: `/v3/domains/${DOMAIN}/aliases/`,
      method: "POST",
      headers: {
        "Authorization": `Basic ${encoded}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          console.log(r.success ? `✅ ImprovMX: ${alias}@${DOMAIN}` : `⚠️  ImprovMX ${alias}: ${JSON.stringify(r.errors||r)}`);
        } catch(e) { console.log(`⚠️  ImprovMX ${alias}: parse error`); }
        resolve();
      });
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

async function addToBrevo(email) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: "ClientBoost", email: `${email}@${DOMAIN}` });
    const req = https.request({
      hostname: "api.brevo.com",
      path: "/v3/senders",
      method: "POST",
      headers: {
        "api-key": API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          console.log(r.id ? `✅ Brevo: ${email}@${DOMAIN}` : `⚠️  Brevo ${email}: ${r.message}`);
        } catch(e) {}
        resolve();
      });
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

async function main() {
  console.log(`🚀 Adding ${emails.length} emails to ImprovMX + Brevo...\n`);
  for (const email of emails) {
    await addToImprovMX(email);
    await addToBrevo(email);
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`\n✅ Done! Check Gmail for ${emails.length} verification emails.`);
}

main();

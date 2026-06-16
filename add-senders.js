async function addToImprovMX(alias) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      alias,
      forward: "raydyawear@gmail.com"
    });

    const encoded = Buffer.from(
      "api:sk_508330bd414c48e7817da35d838436ad"
    ).toString("base64");

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
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          console.log(
            r.success
              ? `✅ ImprovMX: ${alias}@${DOMAIN}`
              : `⚠️ ImprovMX ${alias}: ${JSON.stringify(r.errors || r)}`
          );
        } catch (e) {
          console.log(`⚠️ ImprovMX ${alias}: parse error`);
        }
        resolve();
      });
    });

    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

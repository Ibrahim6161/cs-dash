const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const caseName = "Winter Offensive Weapon Case";
  const url = "https://csstonks.com/case/" + encodeURIComponent(caseName);

  const dumps = [];

  page.on("response", async (res) => {
    try {
      if (
        res.request().method() === "POST" &&
        res.url().includes("graphql")
      ) {
        const json = await res.json();
        dumps.push(json);
      }
    } catch {}
  });

  console.log("Opening:", caseName);
  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForTimeout(5000);

  fs.writeFileSync(
    "graphql-dump.json",
    JSON.stringify(dumps, null, 2),
    "utf8"
  );

  await browser.close();
  console.log("✅ graphql-dump.json written");
})();

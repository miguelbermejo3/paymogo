import { webkit, devices } from "playwright";

const deviceName = process.argv[2] || "iPhone 14";
const url = process.argv[3] || "http://localhost:5173/index.html";

async function run() {
  const device = devices[deviceName];
  if (!device) {
    console.error(`Device not found: "${deviceName}"`);
    console.error("Example: node scripts/iphone-webkit-preview.mjs \"iPhone 14\" \"http://localhost:5173/index.html\"");
    process.exit(1);
  }

  const browser = await webkit.launch({ headless: false });
  const context = await browser.newContext({
    ...device,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });

  console.log(`Opened ${url}`);
  console.log(`Device: ${deviceName}`);
  console.log("Close the browser window to end.");
}

run().catch((err) => {
  console.error("Unable to start iPhone WebKit preview.");
  console.error(err?.message || err);
  process.exit(1);
});

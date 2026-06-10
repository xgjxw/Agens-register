const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

async function main() {
  const extensionPath = path.resolve(__dirname, "..");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agens-ext-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  const page = await context.newPage();
  await page.waitForTimeout(3000);

  const extensionId = readExtensionIdFromPreferences(userDataDir, extensionPath);

  if (!extensionId) {
    throw new Error("未能从 Preferences 读取扩展 ID");
  }

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await page.goto(popupUrl, { waitUntil: "load" });

  console.log("extensionId=", extensionId);
  console.log("popupUrl=", popupUrl);

  await page.screenshot({ path: path.resolve(__dirname, "..", "debug-popup.png"), fullPage: true });

  await page.waitForTimeout(3000);
  await context.close();
}

function readExtensionIdFromPreferences(userDataDir, extensionPath) {
  const prefPath = path.join(userDataDir, "Default", "Preferences");
  if (!fs.existsSync(prefPath)) {
    return "";
  }

  const raw = fs.readFileSync(prefPath, "utf8");
  const data = JSON.parse(raw);
  const settings = data?.extensions?.settings || {};

  for (const [extId, info] of Object.entries(settings)) {
    const loc = info?.path || info?.manifest?.path || "";
    const name = info?.manifest?.name || "";
    if (
      (typeof loc === "string" && path.resolve(loc) === path.resolve(extensionPath)) ||
      (typeof name === "string" && name.includes("Agens"))
    ) {
      return extId;
    }
  }

  return "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

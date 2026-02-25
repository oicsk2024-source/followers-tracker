import fs from "fs";
import { google } from "googleapis";
import { chromium } from "playwright";

function kinshasaNow() {
  const now = new Date();
  const kin = new Date(now.getTime() + 60 * 60 * 1000);
  const date = kin.toISOString().slice(0, 10);
  const time = kin.toISOString().slice(11, 19);
  return { date, time };
}

function normalizeCount(text) {
  if (!text) return null;
  const t = text.replace(/\s/g, "").replace(/,/g, "");
  const m = t.match(/([\d.]+)([KM])?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const suffix = (m[2] || "").toUpperCase();
  if (suffix === "K") return Math.round(num * 1000);
  if (suffix === "M") return Math.round(num * 1000000);
  const asInt = parseInt(t, 10);
  return Number.isFinite(asInt) ? asInt : null;
}

async function getFollowers(page, platform) {
  if (platform === "TikTok") {
    await page.waitForTimeout(2000);
    const txt = await page.locator('[data-e2e="followers-count"]').first().textContent().catch(() => null);
    return normalizeCount(txt);
  }

  if (platform === "Instagram") {
    await page.waitForTimeout(2000);
    const desc = await page.locator('meta[name="description"]').getAttribute("content").catch(() => null);
    if (desc) {
      const m = desc.match(/([\d.,]+[KM]?)\s+Followers/i);
      if (m) return normalizeCount(m[1]);
    }
    return null;
  }

  if (platform === "Facebook") {
    await page.waitForTimeout(2000);
    const desc = await page.locator('meta[name="description"]').getAttribute("content").catch(() => null);
    if (desc) {
      const m = desc.match(/([\d.,]+[KM]?)\s+followers/i);
      if (m) return normalizeCount(m[1]);
    }
    return null;
  }

  return null;
}

async function appendRowsToSheet(rows) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SHEET_ID;
  const range = "Daily Followers Log!A:G";

  const values = rows.map(r => [
    r.Date, r.Time, r.Region, r.Brand, r.Platform, r.Followers ?? "", r.URL
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

async function main() {
  const profiles = JSON.parse(fs.readFileSync("profiles.json", "utf8"));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });
  const page = await context.newPage();

  const { date, time } = kinshasaNow();
  const rows = [];

  for (const p of profiles) {
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const followers = await getFollowers(page, p.platform);
      rows.push({
        Date: date,
        Time: time,
        Region: p.region,
        Brand: p.brand,
        Platform: p.platform,
        Followers: followers,
        URL: p.url
      });
      console.log("OK:", p.platform, p.brand, p.region, "=>", followers);
    } catch (e) {
      rows.push({
        Date: date,
        Time: time,
        Region: p.region,
        Brand: p.brand,
        Platform: p.platform,
        Followers: "",
        URL: p.url
      });
      console.log("FAIL:", p.url, e.message);
    }
  }

  await browser.close();
  await appendRowsToSheet(rows);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

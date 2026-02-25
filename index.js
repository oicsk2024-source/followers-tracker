import fs from "fs";
import { google } from "googleapis";
import { chromium } from "playwright";

function kinshasaNow() {
  // GitHub runners are UTC. Kinshasa is UTC+1.
  const now = new Date();
  const kin = new Date(now.getTime() + 60 * 60 * 1000);
  const date = kin.toISOString().slice(0, 10);
  const time = kin.toISOString().slice(11, 19);
  return { date, time };
}

function normalizeCount(text) {
  if (!text) return null;
  const t = String(text).replace(/\s/g, "").replace(/,/g, "");
  const m = t.match(/([\d.]+)([KM])?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const suffix = (m[2] || "").toUpperCase();
  if (!Number.isFinite(num)) return null;
  if (suffix === "K") return Math.round(num * 1000);
  if (suffix === "M") return Math.round(num * 1000000);

  const asInt = parseInt(t, 10);
  return Number.isFinite(asInt) ? asInt : null;
}

function findFollowerCountInText(text) {
  if (!text) return null;

  // EN + FR keywords
  const patterns = [
    // "24.1K Followers" / "24 118 abonnés"
    /([\d.,]+[KM]?)\s*(Followers|followers|abonnés|abonnes)\b/i,
    // "Followers: 24.1K" / "abonnés : 24 118"
    /(Followers|followers|abonnés|abonnes)\s*[:\-]?\s*([\d.,]+[KM]?)\b/i,
    // Facebook sometimes: "168K people follow this"
    /([\d.,]+[KM]?)\s*(people\s+follow\s+this)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const candidate = m[1] && /[\d]/.test(m[1]) ? m[1] : m[2];
      const n = normalizeCount(candidate);
      if (n) return n;
    }
  }
  return null;
}

async function getFollowers(page, platform) {
  // Let dynamic content settle a bit
  await page.waitForTimeout(2500);

  // 1) TikTok - keep strong selector
  if (platform === "TikTok") {
    const txt = await page
      .locator('[data-e2e="followers-count"]')
      .first()
      .textContent()
      .catch(() => null);
    return normalizeCount(txt);
  }

  // 2) Try meta description (fast + often enough)
  const metaDesc = await page
    .locator('meta[name="description"]')
    .getAttribute("content")
    .catch(() => null);

  let count = findFollowerCountInText(metaDesc);
  if (count) return count;

  // 3) Fallback: full HTML scan
  const html = await page.content().catch(() => "");
  count = findFollowerCountInText(html);
  if (count) return count;

  // 4) Platform specific deeper fallbacks (best-effort; may break in future)

  if (platform === "Instagram") {
    // Some pages expose follower count in JSON blobs (varies frequently)
    const igPatterns = [
      /"edge_followed_by":\{"count":(\d+)\}/,
      /"follower_count":\s*(\d+)/,
      /"followers":\s*(\d+)/ // very broad, last resort
    ];
    for (const re of igPatterns) {
      const m = html.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  if (platform === "Facebook") {
    // Try a bit more FB-specific scanning
    const fbPatterns = [
      /([\d.,]+[KM]?)\s*(followers|abonnés|abonnes)\b/i,
      /([\d.,]+[KM]?)\s*people\s+follow\s+this\b/i
    ];
    for (const re of fbPatterns) {
      const m = html.match(re);
      if (m) {
        const n = normalizeCount(m[1]);
        if (n) return n;
      }
    }
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

  // MUST match your sheet tab name exactly
  const range = "Daily Followers Log!A:G";

  const values = rows.map((r) => [
    r.Date,
    r.Time,
    r.Region,
    r.Brand,
    r.Platform,
    r.Followers ?? "",
    r.URL,
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
    locale: "en-US",
  });

  const page = await context.newPage();
  const { date, time } = kinshasaNow();
  const rows = [];

  for (const p of profiles) {
    // For Facebook, mobile site is usually easier to parse
    const targetUrl =
      p.platform === "Facebook"
        ? p.url.replace("www.facebook.com", "m.facebook.com")
        : p.url;

    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const followers = await getFollowers(page, p.platform);

      rows.push({
        Date: date,
        Time: time,
        Region: p.region,
        Brand: p.brand,
        Platform: p.platform,
        Followers: followers,
        URL: p.url, // store original URL in sheet
      });

      if (!followers) {
        console.log("NO COUNT:", p.platform, p.brand, p.region, "=>", targetUrl);
      } else {
        console.log("OK:", p.platform, p.brand, p.region, "=>", followers);
      }
    } catch (e) {
      rows.push({
        Date: date,
        Time: time,
        Region: p.region,
        Brand: p.brand,
        Platform: p.platform,
        Followers: "",
        URL: p.url,
      });
      console.log("FAIL:", p.platform, p.brand, p.region, "=>", targetUrl, "|", e.message);
    }
  }

  await browser.close();
  await appendRowsToSheet(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

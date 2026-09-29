import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env loader toi gian (khong phu thuoc goi ngoai) - chi doc KEY=VALUE, bo qua
// dong trong/comment. Khong ghi de bien moi truong THAT da co san truoc khi
// file duoc doc (vd khi chay qua systemd/pm2 voi env rieng) - nhung neu 1 key
// xuat hien nhieu lan TRONG CUNG file .env thi dong sau ghi de dong truoc
// (giong hanh vi dotenv thong thuong), tranh bug dong rong o tren "chiem cho"
// khien gia tri that o duoi bi bo qua.
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const preExisting = new Set(Object.keys(process.env));
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!preExisting.has(key)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4600);
const ADMIN_KEY = (process.env.OPENAI_ADMIN_API_KEY || "").trim();
const OPENAI_BASE_URL = "https://api.openai.com/v1";
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function openaiUsageRequest(pathname, params) {
  if (!ADMIN_KEY) {
    const err = new Error(
      "Thieu OPENAI_ADMIN_API_KEY - tao Admin key tai platform.openai.com/settings/organization/admin-keys va dien vao file .env",
    );
    err.code = "missing_admin_key";
    throw err;
  }

  const results = [];
  let page = undefined;
  let guard = 0;

  do {
    const url = new URL(`${OPENAI_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    if (page) url.searchParams.set("page", page);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.error?.message || `OpenAI API loi ${response.status}`;
      const err = new Error(message);
      err.code = data?.error?.code || "openai_api_error";
      err.status = response.status;
      throw err;
    }

    results.push(...(data.data || []));
    page = data.has_more ? data.next_page : undefined;
    guard += 1;
  } while (page && guard < 50);

  return results;
}

function daysToRange(days) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - Number(days || 30) * 86400;
  return { start_time: start, end_time: now };
}

// Cho phep chon khoang ngay tuy y (tu lich tren UI) thay vi chi preset so
// ngay gan day. Parse theo gio dia phuong CUA SERVER (dashboard chi chay
// local tren may admin nen coi nhu la gio dia phuong cua nguoi dung).
function resolveTimeRange(url) {
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T23:59:59`);
    return {
      start_time: Math.floor(start.getTime() / 1000),
      end_time: Math.floor(end.getTime() / 1000),
    };
  }
  const days = url.searchParams.get("days") || "30";
  return daysToRange(days);
}

// Gop tat ca bucket + tat ca "results" ben trong thanh 1 mang phang, kem
// start_time (unix seconds, giu nguyen do chinh xac gio) va day (chuoi
// YYYY-MM-DD) suy tu bucket cha - de frontend nhom lai theo model/project/
// ngay/khung gio tuy y.
function flattenBuckets(buckets) {
  const rows = [];
  for (const bucket of buckets) {
    const startTime = bucket.start_time || 0;
    const day = new Date(startTime * 1000).toISOString().slice(0, 10);
    for (const result of bucket.results || []) {
      rows.push({ day, start_time: startTime, ...result });
    }
  }
  return rows;
}

async function handleUsageCompletions(req, res, url) {
  try {
    const { start_time, end_time } = resolveTimeRange(url);
    // bucket_width 1h de co moc gio chinh xac (frontend tu gom lai thanh
    // khung 2 tieng) - gioi han so bucket hop ly, tranh qua nhieu trang khi
    // xem khoang thoi gian dai.
    // OpenAI gioi han toi da 168 bucket/trang cho bucket_width=1h - ham
    // openaiUsageRequest() da tu phan trang qua has_more/next_page.
    const buckets = await openaiUsageRequest("/organization/usage/completions", {
      start_time,
      end_time,
      bucket_width: "1h",
      group_by: ["model", "project_id", "api_key_id"],
      limit: 168,
    });
    sendJson(res, 200, { ok: true, rows: flattenBuckets(buckets) });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.message,
      code: error.code || "unknown_error",
    });
  }
}

async function handleUsageCosts(req, res, url) {
  try {
    const { start_time, end_time } = resolveTimeRange(url);
    const buckets = await openaiUsageRequest("/organization/costs", {
      start_time,
      end_time,
      bucket_width: "1d",
      group_by: ["line_item", "project_id"],
      limit: 31,
    });
    sendJson(res, 200, { ok: true, rows: flattenBuckets(buckets) });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.message,
      code: error.code || "unknown_error",
    });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(__dirname, "public", safePath);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }
  try {
    const content = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/usage/completions") {
    return handleUsageCompletions(req, res, url);
  }
  if (url.pathname === "/api/usage/costs") {
    return handleUsageCosts(req, res, url);
  }

  const served = await serveStatic(req, res, url.pathname);
  if (!served) {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`AI usage dashboard listening on http://localhost:${PORT}`);
  if (!ADMIN_KEY) {
    console.warn("CANH BAO: chua co OPENAI_ADMIN_API_KEY trong .env - API se tra loi 500.");
  }
});

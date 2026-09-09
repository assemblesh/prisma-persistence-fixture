import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;
const MAX_BODY_BYTES = 8192;
const MAX_VALUE_BYTES = 512;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function authorized(request, runKey) {
  const presented = request.headers["x-run-key"];
  if (typeof presented !== "string" || typeof runKey !== "string" || runKey.length === 0) {
    return false;
  }
  const left = Buffer.from(presented);
  const right = Buffer.from(runKey);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readJson(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) {
    const error = new Error("body too large");
    error.code = "BODY_TOO_LARGE";
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        const error = new Error("body too large");
        error.code = "BODY_TOO_LARGE";
        request.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    request.on("error", reject);
  });
}

function recordResponse(row) {
  return {
    id: row.id,
    value: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function validRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.id === "string" && RECORD_ID.test(value.id) &&
    typeof value.value === "string" && Buffer.byteLength(value.value, "utf8") <= MAX_VALUE_BYTES;
}

export function createServer({ query, runKey }) {
  if (typeof query !== "function") throw new TypeError("query function is required");

  return http.createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://fixture").pathname;
    } catch {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "records" || (parts.length !== 1 && parts.length !== 2)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!authorized(request, runKey)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (request.method === "POST" && parts.length === 1) {
        const body = await readJson(request);
        if (!validRecord(body)) {
          sendJson(response, 400, { error: "invalid_record" });
          return;
        }

        const inserted = await query(
          "INSERT INTO assemble_persistence_records (id, run_key, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id, run_key, payload, created_at",
          [body.id, runKey, body.value]
        );
        if (inserted.rows[0]) {
          sendJson(response, 201, recordResponse(inserted.rows[0]));
          return;
        }

        const existing = await query(
          "SELECT id, run_key, payload, created_at FROM assemble_persistence_records WHERE id = $1",
          [body.id]
        );
        if (!existing.rows[0] || existing.rows[0].run_key !== runKey) {
          sendJson(response, 409, { error: "record_conflict" });
          return;
        }
        sendJson(response, 200, recordResponse(existing.rows[0]));
        return;
      }

      if (request.method === "GET" && parts.length === 2) {
        const id = decodeURIComponent(parts[1]);
        if (!RECORD_ID.test(id)) {
          sendJson(response, 400, { error: "invalid_record_id" });
          return;
        }
        const result = await query(
          "SELECT id, run_key, payload, created_at FROM assemble_persistence_records WHERE id = $1 AND run_key = $2",
          [id, runKey]
        );
        if (!result.rows[0]) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, recordResponse(result.rows[0]));
        return;
      }

      sendJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (error?.code === "BODY_TOO_LARGE") {
        sendJson(response, 413, { error: "body_too_large" });
        return;
      }
      if (error?.message === "invalid json") {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      console.error("request failed");
      sendJson(response, 500, { error: "internal_error" });
    }
  });
}

export function start() {
  const databaseUrl = process.env.DATABASE_URL;
  const runKey = process.env.RUN_KEY;
  if (!databaseUrl || !runKey) {
    console.error("DATABASE_URL and RUN_KEY are required");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000
  });
  const server = createServer({
    runKey,
    query: (text, values) => pool.query(text, values)
  });
  server.on("close", () => pool.end());
  const port = Number(process.env.PORT || 8080);
  server.listen(port, "0.0.0.0", () => {
    console.log(`fixture listening on ${port}`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  start();
}

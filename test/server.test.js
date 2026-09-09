import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer } from "../server.js";

const RUN_KEY = "fixture-test-run-key";
let server;
let baseUrl;
let records;
let calls;

function fakeQuery(text, values) {
  calls.push({ text, values });
  if (text.startsWith("INSERT")) {
    const [id, runKey, payload] = values;
    if (records.has(id)) return { rows: [] };
    const row = { id, run_key: runKey, payload, created_at: "2026-01-01T00:00:00.000Z" };
    records.set(id, row);
    return { rows: [row] };
  }
  const [id, runKey] = values;
  const row = records.get(id);
  if (text.includes("AND run_key") && (!row || row.run_key !== runKey)) return { rows: [] };
  return { rows: row ? [row] : [] };
}

beforeEach(async () => {
  records = new Map();
  calls = [];
  server = createServer({ query: fakeQuery, runKey: RUN_KEY });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("health is public while records require the run key", async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const denied = await fetch(`${baseUrl}/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "unauthorized", value: "nope" })
  });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
});

test("a run-key write can be read back from the same backing store", async () => {
  const write = await fetch(`${baseUrl}/records`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-run-key": RUN_KEY },
    body: JSON.stringify({ id: "redeploy-proof", value: "survives" })
  });
  assert.equal(write.status, 201);
  assert.deepEqual(await write.json(), {
    id: "redeploy-proof",
    value: "survives",
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const read = await fetch(`${baseUrl}/records/redeploy-proof`, {
    headers: { "x-run-key": RUN_KEY }
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    id: "redeploy-proof",
    value: "survives",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(calls[0].values[0], "redeploy-proof");
  assert.match(calls[0].text, /VALUES \(\$1, \$2, \$3\)/);
});

test("bad input is rejected before a database query", async () => {
  const bad = await fetch(`${baseUrl}/records`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-run-key": RUN_KEY },
    body: JSON.stringify({ id: "not valid", value: "x" })
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_record" });
  assert.equal(calls.length, 0);
});

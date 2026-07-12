import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "fr.mjs");

async function fixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/passes")) {
        res.end(JSON.stringify({ event: { metadata: { passId: "pass-1", head: "abcdef1234567890" } } }));
      } else if (req.url === "/api/assessments/request") {
        res.end(JSON.stringify({ requested: [{ recipient: "repo/orchestrator" }] }));
      } else if (req.url === "/data/current.json") {
        res.end(JSON.stringify({
          generatedAt: "2026-07-12T15:00:00.000Z",
          projects: [{ id: "sample", label: "Sample", metrics: { activeWorkstreams: 1, openPrs: 1, openQuestions: 1 } }],
          workstreams: [{
            id: "sample-stream",
            project: "sample",
            title: "Repair import authority",
            status: "active",
            updatedAt: "2026-07-12T14:30:00.000Z",
            reviewState: "User decision required before publication",
            branch: "sample/import-authority",
            chunks: [{ id: "publish", title: "Publish reviewed branch", status: "planned" }],
            questions: [{ id: "Q1", text: "Which contract applies?", status: "open", askedAt: "2026-07-12T14:20:00.000Z" }],
            prs: [{ number: 42, state: "OPEN", headRefName: "sample/import-authority", headRefOid: "abcdef1234567890", updatedAt: "2026-07-12T14:40:00.000Z" }],
            timeline: []
          }]
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "field-report-cli-"));
  const address = server.address();
  return {
    requests,
    env: { ...process.env, FIELD_REPORT_URL: `http://127.0.0.1:${address.port}`, FIELD_REPORT_STATE_DIR: stateDir },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(stateDir, { recursive: true, force: true });
    }
  };
}

test("fr pass record dispatches as a top-level command", async () => {
  const mock = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", "abcdef1234567890", "--verdict", "GO"], { env: mock.env });
    assert.match(stdout, /Recorded review pass pass-1/);
    assert.equal(mock.requests[0].url, "/api/workstreams/sample-stream/passes");
    assert.equal(mock.requests[0].body.verdict, "GO");
  } finally {
    await mock.close();
  }
});

test("fr delegate review dispatches as a top-level command", async () => {
  const mock = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "delegate", "review", "sample-stream"], { env: mock.env });
    assert.match(stdout, /Requested delegated review from repo\/orchestrator/);
    assert.equal(mock.requests[0].url, "/api/assessments/request");
  } finally {
    await mock.close();
  }
});

test("fr catchup advances a durable repository cursor", async () => {
  const mock = await fixture();
  try {
    const first = await exec(process.execPath, [cli, "catchup", "sample"], { env: mock.env });
    assert.match(first.stdout, /initial orientation/);
    assert.match(first.stdout, /Repair import authority/);
    assert.match(first.stdout, /decision needed/);
    const second = await exec(process.execPath, [cli, "catchup", "sample"], { env: mock.env });
    assert.match(second.stdout, /No semantic or delivery changes since the last catch-up/);
    assert.match(second.stdout, /Other attention still open:[\s\S]*Repair import authority/);
  } finally {
    await mock.close();
  }
});

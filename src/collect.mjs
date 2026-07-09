import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function command(command, args, cwd = root) {
  try {
    const { stdout } = await exec(command, args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.stderr?.trim() || error.message };
  }
}

async function collectIssues() {
  const result = await command("af", ["issue", "list", "--other-agents", "--json"]);
  if (!result.ok) return { items: [], error: result.error };
  try {
    const parsed = JSON.parse(result.value || "[]");
    return { items: Array.isArray(parsed) ? parsed : parsed.issues || [] };
  } catch (error) {
    return { items: [], error: `Could not parse AF issue JSON: ${error.message}` };
  }
}

async function collectInbox(agentNames) {
  const messages = [];
  const errors = [];
  for (const agent of agentNames) {
    const result = await command("af", ["inbox", "list", "--for", agent, "--namespace", "--json"]);
    if (!result.ok) {
      errors.push(`${agent}: ${result.error}`);
      continue;
    }
    try {
      const parsed = JSON.parse(result.value || "[]");
      const items = Array.isArray(parsed) ? parsed : parsed.messages || [];
      messages.push(...items.map((message) => ({ ...message, inboxOwner: agent })));
    } catch (error) {
      errors.push(`${agent}: could not parse inbox JSON (${error.message})`);
    }
  }
  return { items: messages, error: errors.length ? errors.join("; ") : undefined };
}

async function collectPullRequests(project) {
  if (!project.githubRepo || project.githubRepo.startsWith("owner/")) return { items: [] };
  const fields = "number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,mergeStateStatus,statusCheckRollup";
  const result = await command("gh", ["pr", "list", "--repo", project.githubRepo, "--state", "all", "--limit", "100", "--json", fields]);
  if (!result.ok) return { items: [], error: result.error };
  try {
    return { items: JSON.parse(result.value || "[]") };
  } catch (error) {
    return { items: [], error: `Could not parse GitHub PR JSON: ${error.message}` };
  }
}

function messageText(message) {
  return String(message.subject || message.title || message.body || message.content || "");
}

function derivedQuestions(stream, inboxMessages) {
  const questions = new Map((stream.questions || []).map((question) => [question.id, question]));
  const relevant = inboxMessages.filter((message) => messageText(message).includes(stream.id));
  for (const message of relevant) {
    const text = messageText(message);
    const question = text.match(/\[QUESTION\s+[^\]]*\s(Q\d+)\]/i);
    const answer = text.match(/\[ANSWER\s+[^\]]*\s(Q\d+)\]/i);
    if (question && !questions.has(question[1])) {
      questions.set(question[1], { id: question[1], text, status: "open", askedAt: message.created_at || message.createdAt });
    }
    if (answer && questions.has(answer[1])) questions.set(answer[1], { ...questions.get(answer[1]), status: "answered" });
  }
  return [...questions.values()];
}

async function main() {
  const { projects } = await readJson(path.join(root, "config/projects.json"));
  const files = (await readdir(path.join(root, "workstreams"))).filter((file) => file.endsWith(".json")).sort();
  const streams = await Promise.all(files.map((file) => readJson(path.join(root, "workstreams", file))));
  const agents = [...new Set(projects.flatMap((project) => [project.coordinator]).concat(streams.map((stream) => stream.fableAgent)).filter(Boolean))];

  const [issues, inbox, ...pullRequestResults] = await Promise.all([
    collectIssues(),
    collectInbox(agents),
    ...projects.map(collectPullRequests)
  ]);

  const prsByProject = Object.fromEntries(projects.map((project, index) => [project.id, pullRequestResults[index]]));
  const enrichedStreams = streams.map((stream) => {
    const livePrs = prsByProject[stream.project]?.items || [];
    const configuredPrs = (stream.prs || []).map((configured) => {
      const number = typeof configured === "number" ? configured : configured.number;
      return { ...configured, ...(livePrs.find((pr) => pr.number === number) || {}), number };
    });
    const branchPr = livePrs.find((pr) => pr.headRefName === stream.branch);
    const assessment = stream.assessment || {};
    return {
      ...stream,
      assessment: {
        ...assessment,
        stale: Boolean(assessment.assessedHead && branchPr?.headRefOid && assessment.assessedHead !== branchPr.headRefOid),
        currentHead: branchPr?.headRefOid || null
      },
      questions: derivedQuestions(stream, inbox.items),
      prs: configuredPrs,
      afIssues: issues.items.filter((issue) => JSON.stringify(issue).includes(stream.id))
    };
  });

  const now = new Date();
  const snapshot = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    projects,
    workstreams: enrichedStreams,
    health: {
      afIssues: issues.error || "ok",
      afInbox: inbox.error || "ok",
      github: Object.fromEntries(projects.map((project) => [project.id, prsByProject[project.id]?.error || "ok"]))
    }
  };

  const dataDir = path.join(root, "data");
  const snapshotDir = path.join(root, "snapshots");
  await mkdir(dataDir, { recursive: true });
  await mkdir(snapshotDir, { recursive: true });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const temp = path.join(dataDir, `current.json.${process.pid}-${randomUUID()}.next`);
  await writeFile(temp, serialized);
  await rename(temp, path.join(dataDir, "current.json"));

  const date = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const stable = JSON.stringify({ projects, workstreams: enrichedStreams });
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 10);
  const dailyFile = path.join(snapshotDir, `${date}-${digest}.json`);
  try {
    await readFile(dailyFile);
  } catch {
    await writeFile(dailyFile, serialized);
  }

  process.stdout.write(`Refreshed ${enrichedStreams.length} workstreams at ${snapshot.generatedAt}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

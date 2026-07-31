#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createStore } from "../src/store.mjs";

const legacyRoot = path.resolve(process.argv[2] || process.env.FIELD_REPORT_LEGACY_ROOT || process.cwd());
const store = createStore();

for (const directory of ["projects", "workstreams", "reviews"]) {
  try { if ((await readdir(path.join(store.root, directory))).length) throw new Error(`Migration target is not empty: ${path.join(store.root, directory)}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }

const legacyProjects = (await json(path.join(legacyRoot, "config", "projects.json"))).projects || [];
for (const project of legacyProjects) {
  await store.saveProject({
    id: project.id,
    label: project.label,
    repoPath: project.repoPath,
    githubRepo: project.githubRepo
  });
}

const workstreamFiles = (await readdir(path.join(legacyRoot, "workstreams"))).filter((file) => file.endsWith(".json"));
let reviewCount = 0;
for (const file of workstreamFiles) {
  const old = await json(path.join(legacyRoot, "workstreams", file));
  const questions = (old.questions || []).map((question) => ({
    id: String(question.id), text: String(question.text), status: question.status === "answered" ? "answered" : "open",
    ...(question.answer ? { answer: String(question.answer) } : {}),
    ...(question.askedAt ? { askedAt: question.askedAt } : {}),
    ...(question.answeredAt ? { answeredAt: question.answeredAt } : {})
  }));
  await store.saveWorkstream({
    id: old.id,
    project: old.project,
    title: old.title,
    outcome: old.outcome || old.summary,
    summary: old.summary,
    status: old.status,
    next: (old.chunks || []).find((chunk) => ["active", "blocked", "planned"].includes(chunk.status))?.title || null,
    ownerTaskId: old.orchestrator || null,
    branch: old.branch || null,
    pullRequests: (old.prs || []).map((pr) => Number(typeof pr === "object" ? pr.number : pr)).filter(Number.isInteger),
    issues: old.issuePrefixes || [],
    references: old.references || [],
    milestones: old.chunks || [],
    questions,
    reviewClass: "full",
    createdAt: old.createdAt || old.updatedAt
  }, { type: "migrated", text: "Migrated from Field Report schema v1", actor: "migrate-v1" });

  try {
    const lines = (await readFile(path.join(legacyRoot, "events", `${old.id}.jsonl`), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    for (const event of lines.filter((item) => item.type === "review_pass")) {
      const metadata = event.metadata || {};
      await store.addReview(old.id, {
        legacy: true,
        legacyEventId: event.id,
        kind: "final",
        role: metadata.reviewRole || "legacy-review",
        head: metadata.head || null,
        baseHead: metadata.baseHead || null,
        reviewerTaskId: metadata.reviewerId || metadata.reviewer || event.actor,
        provider: metadata.provider || null,
        model: metadata.model || null,
        route: metadata.route || null,
        verdict: metadata.verdict || "NO_GO",
        reviewComplete: metadata.reviewComplete === true,
        independent: metadata.independent === true,
        findings: Array.isArray(metadata.findings) ? metadata.findings : [],
        unresolved: Array.isArray(metadata.unresolved) ? metadata.unresolved : [],
        summary: event.text,
        scores: {
          mergeReadiness: Number.isFinite(metadata.mergeReadiness) ? metadata.mergeReadiness : null,
          structuralRisk: Number.isFinite(metadata.structuralRisk) ? metadata.structuralRisk : null,
          implementationQuality: null,
          evidenceConfidence: Number.isFinite(metadata.outcomeConfidence) ? metadata.outcomeConfidence : null
        },
        originalRecordedAt: event.at
      });
      reviewCount += 1;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

process.stdout.write(`Migrated ${legacyProjects.length} projects, ${workstreamFiles.length} workstreams, and ${reviewCount} historical review records from ${legacyRoot}. Historical reviews are preserved for display but cannot satisfy schema-v2 gates.\n`);

const streamsRoot = document.querySelector("#streams");
const attentionRoot = document.querySelector("#attention-list");
const attentionCount = document.querySelector("#attention-count");
const freshness = document.querySelector("#freshness");
const health = document.querySelector("#health");
const refreshButton = document.querySelector("#refresh");

const marks = { complete: "✓", active: "●", planned: "□", blocked: "!" };
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function relativeTime(value) {
  if (!value) return "unknown";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size || unit === "minute") return formatter.format(Math.round(seconds / size), unit);
  }
}

function prHealth(pr) {
  const checks = pr.statusCheckRollup || [];
  const failed = checks.filter((check) => check.conclusion === "FAILURE" || check.state === "FAILURE").length;
  const pending = checks.filter((check) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.status || check.state)).length;
  if (failed) return { state: "failing", label: `${failed} failing` };
  if (pending) return { state: "pending", label: `${pending} pending` };
  if (pr.mergeStateStatus === "CLEAN") return { state: "green", label: "checks green" };
  if (pr.mergeStateStatus === "BLOCKED") return { state: "blocked", label: "merge blocked" };
  return { state: "neutral", label: String(pr.mergeStateStatus || pr.state || "unknown").toLowerCase() };
}

function renderPullRequests(prs) {
  if (!prs.length) return `<p class="empty-line">No associated PR yet</p>`;
  return `<ul class="pr-list">${prs.map((pr) => {
    const health = prHealth(pr);
    const chunks = (pr.chunks || []).length ? ` · ${(pr.chunks || []).length} chunks` : "";
    return `<li><a href="${escapeHtml(pr.url || "#")}">#${pr.number} ${escapeHtml(pr.title || "")}</a><span class="pr-health ${health.state}">${health.label}${chunks}</span></li>`;
  }).join("")}</ul>`;
}

function renderAgents(stream) {
  const status = new Map((stream.agents || []).map((agent) => [agent.name, agent]));
  const item = (label, name) => {
    const agent = status.get(name);
    return `<span><i class="agent-dot ${agent?.running ? "live" : "idle"}" aria-hidden="true"></i>${label}: ${escapeHtml(name || "unassigned")}${agent?.running ? ` · ${escapeHtml(agent.idleFor)} idle` : ""}</span>`;
  };
  return [item("Fable", stream.fableAgent), item("Reviewer", stream.reviewerAgent), item("Codex", stream.codexExecutor)].join("");
}

function renderStream(stream) {
  const ageHours = stream.updatedAt ? (Date.now() - new Date(stream.updatedAt).getTime()) / 36e5 : Infinity;
  const staleNarrative = ["active", "blocked"].includes(stream.status) && ageHours > 12;
  const assessment = stream.assessment || {};
  const readiness = assessment.mergeReadiness == null ? "—" : `${assessment.mergeReadiness}%`;
  const structuralRisk = assessment.structuralRisk == null ? "—" : `${assessment.structuralRisk}%`;
  const assessmentAge = assessment.assessedAt ? `reviewed ${relativeTime(assessment.assessedAt)} by ${assessment.assessedBy || "reviewer"}` : "reviewer rating pending";
  const chunks = (stream.chunks || []).map((chunk) => `<li class="${escapeHtml(chunk.status)}"><span class="mark" aria-hidden="true">${marks[chunk.status] || "□"}</span><span>${escapeHtml(chunk.title)}</span></li>`).join("");
  const openQuestions = (stream.questions || []).filter((question) => question.status === "open");
  const openIssues = (stream.afIssues || []).filter((issue) => issue.status !== "closed");

  return `<article class="stream">
    <div class="stream-head">
      <div><p class="branch-name">${escapeHtml(stream.branch || "No branch")}</p><h3>${escapeHtml(stream.title)}</h3></div>
      <span class="status ${escapeHtml(stream.status)}">${escapeHtml(stream.status)}</span>
    </div>
    <p class="summary">${escapeHtml(stream.liveStatus?.text || stream.summary)}</p>
    <p class="review-state">${escapeHtml(stream.reviewState || "No explicit review gate recorded")}</p>
    <div class="branch-rating" aria-label="Reviewer-owned branch assessment">
      <div><span>Merge readiness</span><strong>${readiness}</strong></div>
      <div><span>Structural rebuild risk</span><strong>${structuralRisk}</strong></div>
      <p><span>${escapeHtml(assessmentAge)}</span>${assessment.stale ? `<b>Stale: branch head changed</b>` : ""}</p>
      ${assessment.rationale ? `<p class="rating-rationale">${escapeHtml(assessment.rationale)}</p>` : ""}
    </div>
    <ul class="chunks" aria-label="Work chunks">${chunks}</ul>
    ${openQuestions.length ? `<div class="question-block"><strong>Open decision</strong>${openQuestions.map((question) => `<p>${escapeHtml(question.text)}</p>`).join("")}</div>` : ""}
    ${renderPullRequests(stream.prs || [])}
    <div class="stream-foot">
      <div class="agents">${renderAgents(stream)}</div>
      <div class="stream-meta">
        <span class="${staleNarrative ? "stale" : ""}">${staleNarrative ? "Stale narrative · " : ""}updated ${relativeTime(stream.updatedAt)}</span>
        <span>${openIssues.length} open AF issue${openIssues.length === 1 ? "" : "s"}</span>
      </div>
    </div>
    <details class="session-editor">
      <summary>Edit agent sessions</summary>
      <form data-workstream-id="${escapeHtml(stream.id)}">
        <label>Fable workstream agent<input name="fableAgent" value="${escapeHtml(stream.fableAgent || "")}" placeholder="AF name or session ID"></label>
        <label>Reviewer<input name="reviewerAgent" value="${escapeHtml(stream.reviewerAgent || "")}" placeholder="AF name or session ID"></label>
        <label>Codex executor<input name="codexExecutor" value="${escapeHtml(stream.codexExecutor || "")}" placeholder="AF name or session ID"></label>
        <div class="session-actions"><button type="submit">Save sessions</button><span class="save-status" aria-live="polite"></span></div>
      </form>
    </details>
  </article>`;
}

function renderProject(project, workstreams) {
  const metrics = project.metrics || {};
  const repo = project.repoState || {};
  const order = { blocked: 0, active: 1, planned: 2, complete: 3 };
  const sorted = [...workstreams].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return `<section class="repo-track" aria-labelledby="track-${escapeHtml(project.id)}">
    <header class="repo-head">
      <div><p class="eyebrow">Repository track</p><h2 id="track-${escapeHtml(project.id)}">${escapeHtml(project.label)}</h2><p class="muted">Coordinator ${escapeHtml(project.coordinator || "unassigned")} · ${escapeHtml(repo.rootBranch || "repo state unavailable")}</p></div>
      <div class="repo-metrics">
        <span><b>${metrics.activeWorkstreams ?? 0}</b> active</span>
        <span><b>${metrics.openPrs ?? 0}</b> PRs</span>
        <span><b>${metrics.openQuestions ?? 0}</b> questions</span>
        <span><b>${metrics.runningAgents ?? 0}</b> agents</span>
      </div>
    </header>
    ${repo.prunableCount ? `<p class="repo-warning">${repo.prunableCount} prunable worktrees · ${repo.worktreeCount} total</p>` : `<p class="repo-context">${repo.worktreeCount ?? "—"} worktrees · ${repo.rootDirtyFiles ?? "—"} dirty files · ${metrics.openIssues ?? 0} open AF issues</p>`}
    <div class="track-streams">${sorted.map(renderStream).join("")}</div>
  </section>`;
}

function render(data) {
  streamsRoot.innerHTML = data.projects.map((project) => renderProject(project, data.workstreams.filter((stream) => stream.project === project.id))).join("");

  const attention = data.workstreams.flatMap((stream) => {
    const items = (stream.questions || []).filter((question) => question.status === "open").map((question) => ({ stream, label: `Open question ${question.id}`, text: question.text }));
    if (stream.status === "blocked") items.push({ stream, label: "Blocked", text: stream.reviewState || "Workstream is blocked." });
    if (stream.assessment?.stale) items.push({ stream, label: "Stale rating", text: "The branch head advanced after the reviewer assessment." });
    for (const pr of stream.prs || []) {
      const prState = prHealth(pr);
      if (prState.state === "failing") items.push({ stream, label: `PR #${pr.number}`, text: prState.label });
    }
    return items;
  });
  attentionCount.textContent = `${attention.length}`;
  attentionRoot.innerHTML = attention.map(({ stream, label, text }) => `<div class="attention-item"><strong>${escapeHtml(stream.title)} · ${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>`).join("");
  freshness.textContent = `Sources refreshed ${relativeTime(data.generatedAt)} · ${new Date(data.generatedAt).toLocaleString()}`;
  health.textContent = JSON.stringify(data.health, null, 2);

  for (const form of streamsRoot.querySelectorAll(".session-editor form")) form.addEventListener("submit", saveSessions);
}

async function saveSessions(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector(".save-status");
  button.disabled = true;
  status.textContent = "Saving…";
  try {
    const response = await fetch(`/api/workstreams/${encodeURIComponent(form.dataset.workstreamId)}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Save failed");
    await load();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function load() {
  const response = await fetch(`/data/current.json?t=${Date.now()}`);
  if (!response.ok) throw new Error(`Could not load dashboard state (${response.status})`);
  render(await response.json());
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    if (!response.ok) throw new Error((await response.json()).error || "Refresh failed");
    await load();
  } catch (error) {
    freshness.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh sources";
  }
});

load().catch((error) => { freshness.textContent = error.message; });

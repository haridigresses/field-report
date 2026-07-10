const portfolioRoot = document.querySelector("#portfolio");
const briefRoot = document.querySelector("#workstream-brief");
const repoNav = document.querySelector("#repo-nav");
const freshness = document.querySelector("#freshness");
const health = document.querySelector("#health");
const refreshButton = document.querySelector("#refresh");
const totalStreams = document.querySelector("#total-streams");
const portfolioSignal = document.querySelector("#portfolio-signal");

let dashboard = null;
let activeRepo = "all";
let activeStream = null;

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
  if (failed) return { level: "critical", label: `${failed} checks failing` };
  if (pending) return { level: "watch", label: `${pending} checks pending` };
  if (pr.mergeStateStatus === "CLEAN") return { level: "steady", label: "green" };
  if (pr.mergeStateStatus === "BLOCKED") return { level: "critical", label: "merge blocked" };
  return { level: "neutral", label: String(pr.mergeStateStatus || pr.state || "unknown").toLowerCase() };
}

function openQuestions(stream) {
  return (stream.questions || []).filter((question) => question.status === "open");
}

function phase(stream) {
  if (stream.status === "complete") return "Complete";
  if (stream.status === "blocked") return "Recovery";
  if ((stream.prs || []).some((pr) => pr.state === "OPEN")) return "Review";
  const active = (stream.chunks || []).find((chunk) => chunk.status === "active");
  if (active?.id === "publish") return "Publication";
  return "Build";
}

function confidence(stream) {
  const rating = stream.assessment?.mergeReadiness;
  return rating == null ? { value: "Pending", level: "neutral" } : { value: `${rating}%`, level: rating < 60 ? "critical" : rating < 80 ? "watch" : "steady" };
}

function risk(stream) {
  if (stream.assessment?.stale) return { label: "Assessment stale", level: "critical" };
  if (stream.status === "blocked") return { label: "Delivery blocked", level: "critical" };
  const structural = stream.assessment?.structuralRisk;
  if (structural != null && structural >= 30) return { label: "Structural", level: "critical" };
  if (openQuestions(stream).length) return { label: "Decision", level: "watch" };
  if (!(stream.prs || []).length) return { label: "Pre-publication", level: "watch" };
  return { label: "Low", level: "steady" };
}

function delivery(stream) {
  const prs = stream.prs || [];
  if (!prs.length) {
    const completed = (stream.chunks || []).filter((chunk) => chunk.status === "complete").length;
    return `<span class="delivery-main">Pre-PR</span><span class="delivery-sub">${completed}/${(stream.chunks || []).length} milestones complete</span>`;
  }
  return prs.map((pr) => {
    const health = prHealth(pr);
    return `<span class="delivery-main">PR ${pr.number}</span><span class="delivery-sub signal-${health.level}">${escapeHtml(health.label)}</span>`;
  }).join("");
}

function nextMilestone(stream) {
  return (stream.chunks || []).find((chunk) => ["blocked", "active", "planned"].includes(chunk.status))?.title || "Outcome delivered";
}

function projectFor(stream) {
  return dashboard.projects.find((project) => project.id === stream.project);
}

function renderRepoNav() {
  const buttons = [{ id: "all", label: "All workstreams" }, ...dashboard.projects.map((project) => ({ id: project.id, label: project.label }))];
  repoNav.innerHTML = buttons.map((item) => `<button class="repo-filter ${activeRepo === item.id ? "selected" : ""}" data-repo="${escapeHtml(item.id)}" type="button">${escapeHtml(item.label)}</button>`).join("");
  repoNav.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    activeRepo = button.dataset.repo;
    activeStream = null;
    renderDashboard();
  }));
}

function renderPortfolio() {
  const streams = dashboard.workstreams.filter((stream) => activeRepo === "all" || stream.project === activeRepo);
  const sorted = [...streams].sort((a, b) => {
    const weight = (stream) => stream.status === "blocked" ? 0 : openQuestions(stream).length ? 1 : stream.assessment?.stale ? 2 : 3;
    return weight(a) - weight(b);
  });
  totalStreams.textContent = `${streams.length} outcomes`;
  const blocked = streams.filter((stream) => stream.status === "blocked").length;
  const uncertain = streams.filter((stream) => openQuestions(stream).length).length;
  const pending = streams.filter((stream) => stream.assessment?.mergeReadiness == null).length;
  portfolioSignal.textContent = `${blocked} blocked · ${uncertain} uncertain · ${pending} awaiting confidence`;

  portfolioRoot.innerHTML = `<div class="portfolio-header" aria-hidden="true">
    <span>Outcome</span><span>Phase</span><span>Blocked</span><span>Uncertain</span><span>Delivery</span><span>Confidence</span><span>Risk</span>
  </div>${sorted.map((stream) => {
    const blocked = stream.status === "blocked";
    const uncertainty = openQuestions(stream).length;
    const confidenceState = confidence(stream);
    const riskState = risk(stream);
    const selected = activeStream === stream.id;
    return `<button class="portfolio-row ${selected ? "selected" : ""}" type="button" data-stream="${escapeHtml(stream.id)}" aria-pressed="${selected}">
      <span class="outcome"><b>${escapeHtml(stream.title)}</b><small>${escapeHtml(nextMilestone(stream))}</small></span>
      <span data-label="Phase">${phase(stream)}</span>
      <span data-label="Blocked" class="${blocked ? "signal-critical" : "signal-steady"}">${blocked ? "Yes" : "No"}</span>
      <span data-label="Uncertain" class="${uncertainty ? "signal-watch" : "signal-steady"}">${uncertainty ? `Yes · ${uncertainty}` : "No"}</span>
      <span data-label="Delivery" class="delivery">${delivery(stream)}</span>
      <span data-label="Confidence" class="signal-${confidenceState.level}">${confidenceState.value}</span>
      <span data-label="Risk" class="signal-${riskState.level}">${escapeHtml(riskState.label)}</span>
    </button>`;
  }).join("")}`;
  portfolioRoot.querySelectorAll(".portfolio-row").forEach((row) => row.addEventListener("click", (event) => {
    activeStream = activeStream === row.dataset.stream ? null : row.dataset.stream;
    renderPortfolio();
    renderBrief();
    if (activeStream) briefRoot.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderDeliveryChain(stream) {
  const prs = stream.prs || [];
  return `<ol class="milestone-list">${(stream.chunks || []).map((chunk) => {
    const linked = prs.filter((pr) => (pr.chunks || []).includes(chunk.id));
    const artifacts = linked.length ? linked.map((pr) => `<a href="${escapeHtml(pr.url || "#")}" target="_blank" rel="noreferrer">PR ${pr.number}</a>`).join(", ") : "No PR yet";
    return `<li class="milestone milestone-${escapeHtml(chunk.status)}"><span class="milestone-mark" aria-hidden="true"></span><div><b>${escapeHtml(chunk.title)}</b><span>${escapeHtml(chunk.status)} · ${artifacts}</span></div></li>`;
  }).join("")}</ol>`;
}

function renderAgents(stream) {
  const status = new Map((stream.agents || []).map((agent) => [agent.name, agent]));
  return [["Fable", stream.fableAgent], ["Reviewer", stream.reviewerAgent], ["Codex", stream.codexExecutor]].map(([label, name]) => {
    const agent = status.get(name);
    return `<span><i class="agent-dot ${agent?.running ? "live" : ""}"></i>${label}: ${escapeHtml(name || "unassigned")}</span>`;
  }).join("");
}

function renderBrief() {
  const stream = dashboard.workstreams.find((candidate) => candidate.id === activeStream);
  if (!stream) {
    briefRoot.innerHTML = `<p class="brief-placeholder">Select an outcome to inspect its situation, delivery chain, and supporting evidence.</p>`;
    return;
  }
  const project = projectFor(stream);
  const questions = openQuestions(stream);
  const assessment = stream.assessment || {};
  const confidenceState = confidence(stream);
  const riskState = risk(stream);
  const issues = (stream.afIssues || []).filter((issue) => issue.status !== "closed");
  briefRoot.innerHTML = `<article class="brief">
    <header class="brief-head">
      <div><p class="kicker">${escapeHtml(project?.label || stream.project)} · ${phase(stream)}</p><h2>${escapeHtml(stream.title)}</h2></div>
      <button class="close-brief" type="button" aria-label="Close workstream brief">Close</button>
    </header>
    <div class="situation">
      <p>${escapeHtml(stream.liveStatus?.text || stream.summary)}</p>
      <dl>
        <div><dt>Current gate</dt><dd>${escapeHtml(stream.reviewState || "No gate recorded")}</dd></div>
        <div><dt>Next milestone</dt><dd>${escapeHtml(nextMilestone(stream))}</dd></div>
        <div><dt>Confidence</dt><dd class="signal-${confidenceState.level}">${confidenceState.value}</dd></div>
        <div><dt>Material risk</dt><dd class="signal-${riskState.level}">${escapeHtml(riskState.label)}</dd></div>
      </dl>
    </div>
    <div class="brief-grid">
      <section><div class="subhead"><h3>Delivery chain</h3><span>${(stream.chunks || []).filter((chunk) => chunk.status === "complete").length}/${(stream.chunks || []).length} milestones</span></div>${renderDeliveryChain(stream)}</section>
      <section><div class="subhead"><h3>Uncertainty & review</h3><span>${questions.length ? `${questions.length} open` : "No open questions"}</span></div>
        ${questions.length ? `<ul class="question-list">${questions.map((question) => `<li>${escapeHtml(question.text)}</li>`).join("")}</ul>` : `<p class="quiet">No unresolved product or technical question is recorded.</p>`}
        <div class="review-evidence">
          <p><b>Structural rebuild risk</b><span>${assessment.structuralRisk == null ? "Pending" : `${assessment.structuralRisk}%`}</span></p>
          ${assessment.rationale ? `<p class="rationale">${escapeHtml(assessment.rationale)}</p>` : `<p class="quiet">Reviewer assessment pending.</p>`}
          ${assessment.stale ? `<p class="critical-note">Assessment is stale because the branch head changed.</p>` : ""}
        </div>
      </section>
    </div>
    <footer class="evidence">
      <div><b>Evidence</b><span>${escapeHtml(stream.branch || "No branch")} · ${issues.length} open AF issue${issues.length === 1 ? "" : "s"} · updated ${relativeTime(stream.updatedAt)}</span></div>
      <div class="agents">${renderAgents(stream)}</div>
      <details class="session-editor"><summary>Agent sessions</summary><form data-workstream-id="${escapeHtml(stream.id)}">
        <label>Fable<input name="fableAgent" value="${escapeHtml(stream.fableAgent || "")}"></label>
        <label>Reviewer<input name="reviewerAgent" value="${escapeHtml(stream.reviewerAgent || "")}"></label>
        <label>Codex<input name="codexExecutor" value="${escapeHtml(stream.codexExecutor || "")}"></label>
        <button type="submit">Save</button><span class="save-status" aria-live="polite"></span>
      </form></details>
    </footer>
  </article>`;
  briefRoot.querySelector(".close-brief").addEventListener("click", () => { activeStream = null; renderPortfolio(); renderBrief(); });
  briefRoot.querySelector("form").addEventListener("submit", saveSessions);
}

function renderDashboard() {
  renderRepoNav();
  renderPortfolio();
  renderBrief();
  freshness.textContent = `Snapshot ${new Date(dashboard.generatedAt).toLocaleString()} · ${relativeTime(dashboard.generatedAt)}`;
  health.textContent = JSON.stringify(dashboard.health, null, 2);
}

async function saveSessions(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector(".save-status");
  button.disabled = true;
  status.textContent = "Saving…";
  try {
    const response = await fetch(`/api/workstreams/${encodeURIComponent(form.dataset.workstreamId)}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Save failed");
    await load();
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
}

async function load() {
  const response = await fetch(`/data/current.json?t=${Date.now()}`);
  if (!response.ok) throw new Error(`Could not load dashboard state (${response.status})`);
  dashboard = await response.json();
  renderDashboard();
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    if (!response.ok) throw new Error((await response.json()).error || "Refresh failed");
    await load();
  } catch (error) { freshness.textContent = error.message; } finally { refreshButton.disabled = false; refreshButton.textContent = "Refresh"; }
});

load().catch((error) => { freshness.textContent = error.message; });

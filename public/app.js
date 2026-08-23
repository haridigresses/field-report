const portfolio = document.querySelector("#portfolio");
const attention = document.querySelector("#attention");
const projects = document.querySelector("#projects");
const freshness = document.querySelector("#freshness");
const refresh = document.querySelector("#refresh");
const detail = document.querySelector("#detail");
const detailBody = document.querySelector("#detail-body");
let state;
let activeProject = "all";

const escape = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const relative = (value) => new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((new Date(value) - Date.now()) / 3600000), "hour");

function projectFor(stream) { return state.projects.find((project) => project.id === stream.project); }
function currentPr(stream) { return projectFor(stream)?.pullRequests?.find((pr) => stream.pullRequests.includes(pr.number) || pr.headRefName === stream.branch); }
function openQuestions(stream) { return stream.questions.filter((question) => question.status === "open"); }
function reasons(stream) {
  const result = [];
  const pr = currentPr(stream);
  if (stream.status === "blocked") result.push("blocked");
  if (["planned", "active", "blocked"].includes(stream.status) && !stream.ownerTaskId) result.push("owner task unassigned");
  if (["planned", "active", "blocked"].includes(stream.status) && !stream.next) result.push("next action missing");
  if (openQuestions(stream).length) result.push(`${openQuestions(stream).length} open question${openQuestions(stream).length === 1 ? "" : "s"}`);
  if (stream.delegations.some((item) => item.type === "work" && item.status !== "complete")) result.push("work delegation incomplete");
  if (stream.branch && !stream.publication?.ready) result.push(...(stream.publication?.reasons || ["publication evidence missing or stale"]));
  return result;
}

function renderProjects() {
  projects.innerHTML = [{ id: "all", label: "All" }, ...state.projects].map((project) => `<button data-project="${escape(project.id)}" class="${activeProject === project.id ? "active" : ""}">${escape(project.label)}</button>`).join("");
  projects.querySelectorAll("button").forEach((button) => button.onclick = () => { activeProject = button.dataset.project; render(); });
}

function row(stream) {
  const signals = reasons(stream);
  const pr = currentPr(stream);
  return `<button class="row" data-id="${escape(stream.id)}">
    <span><strong>${escape(stream.title)}</strong><small>${escape(stream.summary)}</small></span>
    <span>${escape(stream.status)}</span>
    <span>${pr ? `PR #${pr.number} · ${pr.isDraft ? "draft" : "ready"}` : escape(stream.branch || "No branch")}</span>
    <span class="${signals.length ? "warn" : "good"}">${signals.length ? escape(signals.join(" · ")) : "No active signal"}</span>
    <span>${escape(stream.next || "Not recorded")}</span>
  </button>`;
}

function open(stream) {
  const reviews = stream.reviews.slice().reverse();
  const score = (review) => review.scores ? `<br><small>Readiness ${review.scores.mergeReadiness}% · Structural risk ${review.scores.structuralRisk}% · Implementation quality ${review.scores.implementationQuality}% · Evidence confidence ${review.scores.evidenceConfidence}% · Outcome confidence ${review.scores.outcomeConfidence}%</small><br><small>${escape(Object.values(review.scoreRationale || {}).join(" · "))}</small>` : "";
  const signals = (review) => review.necessity ? `<br><small>Necessity ${escape(review.necessity)} · Scope drift ${escape(review.scopeDrift)} · Contract integrity ${escape(review.contractIntegrity)} · Evidence quality ${escape(review.evidenceQuality)}</small><br><small>Simpler path: ${escape(review.simplerPath)}</small>` : "";
  detailBody.innerHTML = `<p class="eyebrow">${escape(stream.project)} · ${escape(stream.id)}</p><h2>${escape(stream.title)}</h2><p>${escape(stream.summary)}</p>
    <dl><div><dt>Status</dt><dd>${escape(stream.status)}</dd></div><div><dt>Branch</dt><dd>${escape(stream.branch || "None")}</dd></div><div><dt>Owner task</dt><dd>${escape(stream.ownerTaskId || "Unassigned")}</dd></div></dl>
    <h3>Next</h3><p>${escape(stream.next || "Not recorded")}</p>
    <h3>Open questions</h3>${openQuestions(stream).length ? `<ul>${openQuestions(stream).map((question) => `<li><b>${escape(question.id)}</b> ${escape(question.text)}</li>`).join("")}</ul>` : `<p class="quiet">None</p>`}
    <h3>Review evidence</h3>${reviews.length ? `<ul>${reviews.map((review) => `<li><b>${escape(review.role)}</b> ${escape(review.verdict)} · ${escape((review.tree || review.head || "").slice(0, 12))}${review.legacy ? " · historical" : ""}<br><small>${escape(review.summary)}</small>${score(review)}${signals(review)}</li>`).join("")}</ul>` : `<p class="quiet">None</p>`}`;
  detail.showModal();
}

function render() {
  renderProjects();
  const visible = state.workstreams.filter((stream) => activeProject === "all" || stream.project === activeProject);
  const urgent = visible.filter((stream) => stream.status !== "complete" && reasons(stream).length);
  attention.innerHTML = `<h2>Needs attention</h2>${urgent.length ? urgent.map(row).join("") : `<p class="quiet">Nothing currently requires intervention.</p>`}`;
  portfolio.innerHTML = `<h2>Outcomes</h2>${visible.map(row).join("")}`;
  document.querySelectorAll(".row").forEach((element) => element.onclick = () => open(state.workstreams.find((stream) => stream.id === element.dataset.id)));
}

async function load() { const response = await fetch("/api/state"); state = await response.json(); freshness.textContent = `Refreshed ${relative(state.generatedAt)}`; render(); }
refresh.onclick = async () => { refresh.disabled = true; await fetch("/api/refresh", { method: "POST" }); await load(); refresh.disabled = false; };
document.querySelector("#close").onclick = () => detail.close();
load().catch((error) => { portfolio.textContent = error.message; });

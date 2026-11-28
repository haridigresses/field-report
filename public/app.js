const summaryEl = document.querySelector("#summary");
const projectsEl = document.querySelector("#projects");
const readyEl = document.querySelector("#ready-merge");
const attentionEl = document.querySelector("#attention");
const portfolioEl = document.querySelector("#portfolio");
const freshnessEl = document.querySelector("#freshness");
const refreshBtn = document.querySelector("#refresh");
const detailDialog = document.querySelector("#detail");
const detailBody = document.querySelector("#detail-body");
document.querySelector("#close").onclick = () => detailDialog.close();

let state = { projects: [], units: [], generatedAt: null };
let activeProject = "all";

const escape = (value = "") => String(value).replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[ch]);

function relativeTime(iso) {
  if (!iso) return "just now";
  const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 48) return rtf.format(diffHr, "hour");
  return rtf.format(Math.round(diffHr / 24), "day");
}

function seatBadge(role, seat) {
  const shortRole = role[0].toUpperCase();
  if (!seat || seat.state === "missing") return `<span class="pill muted" title="${escape(role)}: unreviewed">${shortRole}:—</span>`;
  if (seat.state === "blocked") return `<span class="pill warn" title="${escape(role)}: NO_GO">${shortRole}:NO_GO</span>`;
  const carried = seat.carried ? `*` : "";
  return `<span class="pill good" title="${escape(role)}: GO${seat.carried ? ` (carried, ${seat.behind} behind)` : ""}">${shortRole}:GO${carried}</span>`;
}

function ciThreadSummary(unit) {
  if (!unit.pr) return unit.worktree?.dirty ? "Dirty worktree" : (unit.worktree ? "Clean worktree" : "Local branch");
  const parts = [];
  const c = unit.pr.checks;
  if (!c || c.total === 0) parts.push("CI: none");
  else if (c.failed > 0) parts.push(`CI: ${c.failed} fail`);
  else if (c.pending > 0) parts.push(`CI: ${c.pending} pending`);
  else parts.push(`CI: ${c.passed} ok`);

  const t = unit.pr.threads;
  if (t) {
    const openCount = t.botOpen + t.humanNeedsAction + t.humanAwaiting;
    if (openCount > 0) parts.push(`${openCount} open thread${openCount === 1 ? "" : "s"}`);
    else if (t.total > 0) parts.push(`${t.resolved} resolved`);
  }
  return parts.join(" · ");
}

function rowTone(unit) {
  if (unit.stage === "ready-to-merge" || unit.stage === "mrr-ready") return "good";
  if (unit.stage === "needs-human") return "warn";
  return "";
}

function renderRow(unit) {
  const title = unit.pr?.title || unit.subject || unit.branch;
  const sub = `${unit.projectLabel} · ${unit.branch} @ ${String(unit.head || "").slice(0, 8)}`;
  const seatsHtml = ["correctness", "design", "intent"].map((role) => seatBadge(role, unit.mrr?.seats?.[role])).join(" ");
  const signalText = unit.attention?.length
    ? unit.attention.join(" · ")
    : (unit.mrr?.intentSummary ? unit.mrr.intentSummary.replace(/[*#`_]/g, "").slice(0, 110) : unit.mrr?.label || "In progress");
  const tone = rowTone(unit);
  return `<button class="row" data-id="${escape(unit.id)}">
    <span><strong>${escape(title)}</strong><small>${escape(sub)}</small></span>
    <span class="${tone}">${escape(unit.stageLabel)}</span>
    <span class="pills">${seatsHtml}</span>
    <span>${escape(ciThreadSummary(unit))}</span>
    <span class="${tone}"><small>${escape(signalText)}</small></span>
  </button>`;
}

function renderSummary(visible) {
  const readyMerge = visible.filter((u) => u.stage === "ready-to-merge").length;
  const needsYou = visible.filter((u) => u.stage === "needs-human").length;
  const draftOrReady = visible.filter((u) => u.stage === "draft-ci" || u.stage === "mrr-ready").length;
  const localOnly = visible.filter((u) => u.stage === "in-progress").length;
  summaryEl.innerHTML = [
    `<div class="stat"><span class="stat-num good">${readyMerge}</span><span class="quiet">Ready for your merge</span></div>`,
    `<div class="stat"><span class="stat-num ${needsYou ? "warn" : ""}">${needsYou}</span><span class="quiet">Needs attention / call</span></div>`,
    `<div class="stat"><span class="stat-num">${draftOrReady}</span><span class="quiet">MRR ready / Draft CI</span></div>`,
    `<div class="stat"><span class="stat-num">${localOnly}</span><span class="quiet">Local branches</span></div>`
  ].join("");
}

function renderProjectFilter() {
  const counts = new Map();
  for (const unit of state.units) counts.set(unit.project, (counts.get(unit.project) || 0) + 1);
  const items = [
    { id: "all", label: `All (${state.units.length})`, warn: false },
    ...state.projects.map((p) => ({
      id: p.id,
      label: `${p.label} (${counts.get(p.id) || 0})`,
      warn: p.health?.git !== "ok"
    }))
  ];
  projectsEl.innerHTML = items.map((item) => `<button data-project="${escape(item.id)}" class="${activeProject === item.id ? "active" : ""}${item.warn ? " warn" : ""}">${escape(item.label)}</button>`).join("");
  projectsEl.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      activeProject = btn.dataset.project;
      render();
    };
  });
}

function openDetail(unit) {
  if (!unit) return;
  const prLink = unit.pr?.url && /^https?:\/\//i.test(unit.pr.url)
    ? `<a href="${escape(unit.pr.url)}" target="_blank" rel="noopener noreferrer">PR #${escape(unit.pr.number)}${unit.pr.isDraft ? " (Draft)" : ""} — ${escape(unit.pr.title)}</a>`
    : (unit.pr ? `PR #${escape(unit.pr.number)}` : "No open pull request");

  const questionsHtml = unit.mrr?.questions?.length
    ? `<h3>Questions for You</h3><ul>${unit.mrr.questions.map((q) => `<li class="warn"><b>${escape(q.role)}:</b> ${escape(q.question)}</li>`).join("")}</ul>`
    : "";

  const seatsHtml = ["correctness", "design", "intent"].map((role) => {
    const s = unit.mrr?.seats?.[role];
    if (!s || s.state === "missing") return `<li><b>${escape(role)}:</b> <span class="quiet">not reviewed yet</span></li>`;
    const scores = s.scores
      ? `<br><small class="quiet">Readiness ${s.scores.mergeReadiness}% · Structural risk ${s.scores.structuralRisk}% · Quality ${s.scores.implementationQuality}% · Evidence ${s.scores.evidenceConfidence}% · Outcome ${s.scores.outcomeConfidence}%</small>`
      : "";
    const carried = s.carried ? ` · carried from ${escape(String(s.head || "").slice(0, 10))} (${s.behind} behind)` : ` · ${escape(String(s.head || "").slice(0, 10))}`;
    const findings = (s.open || []).map((f) => `<div class="warn"><small><b>Open ${escape(f.id)}:</b> ${escape(f.text)}</small></div>`).join("");
    const accepted = (s.accepted || []).map((f) => `<div><small class="quiet"><b>Accepted ${escape(f.id)} (${escape(f.disposition.actor)}):</b> ${escape(f.disposition.reason)}</small></div>`).join("");
    return `<li>
      <b>${escape(role)}</b> [${escape(s.model)}] — <b class="${s.state === "blocked" ? "warn" : "good"}">${escape(s.verdict)}</b>${carried}
      <br><small>${escape(s.summary || "")}</small>
      ${scores}
      ${s.simplerPath ? `<br><small class="quiet">Simpler path: ${escape(s.simplerPath)}</small>` : ""}
      ${findings}${accepted}
    </li>`;
  }).join("");

  const botsHtml = unit.pr
    ? `<h3>GitHub PR, CI &amp; Review Threads</h3>
       <p>${escape(ciThreadSummary(unit))}${unit.pr.threadsError ? ` <small class="warn">(${escape(unit.pr.threadsError)})</small>` : ""}</p>
       ${unit.bots?.reasons?.length ? `<ul>${unit.bots.reasons.map((r) => `<li><small>${escape(r)}</small></li>`).join("")}</ul>` : `<p class="good">CI checks passed and all review threads settled.</p>`}`
    : "";

  detailBody.innerHTML = `
    <p class="eyebrow">${escape(unit.projectLabel)} · ${escape(unit.branch)}</p>
    <h2>${escape(unit.pr?.title || unit.subject || unit.branch)}</h2>
    <dl>
      <div><dt>Stage</dt><dd>${escape(unit.stageLabel)}</dd></div>
      <div><dt>Pull Request</dt><dd>${prLink}</dd></div>
      <div><dt>MRR Gate</dt><dd>${escape(unit.mrr?.label || "UNREVIEWED")}</dd></div>
      <div><dt>Checkout</dt><dd>${escape(unit.worktree ? `${unit.worktree.path}${unit.worktree.dirty ? " (dirty)" : " (clean)"}` : "Not checked out in a worktree")}</dd></div>
      <div><dt>Target</dt><dd><code>${escape(String(unit.baseHead || "").slice(0, 10))}..${escape(String(unit.head || "").slice(0, 10))}</code> (base: ${escape(unit.baseBranch)})</dd></div>
      <div><dt>Updated</dt><dd>${escape(relativeTime(unit.updatedAt))}</dd></div>
    </dl>
    ${questionsHtml}
    <h3>Intent Playback</h3>
    <pre class="intent-box">${escape(unit.mrr?.intentSummary || "Intent seat has not run on this branch yet.")}</pre>
    <h3>Three-Seat MRR</h3>
    <ul>${seatsHtml}</ul>
    ${botsHtml}
  `;
  detailDialog.showModal();
}

function render() {
  renderProjectFilter();
  const visible = state.units.filter((u) => activeProject === "all" || u.project === activeProject);
  renderSummary(visible);

  const readyMerge = visible.filter((u) => u.stage === "ready-to-merge");
  readyEl.innerHTML = readyMerge.length
    ? `<h2>Ready for your merge</h2>${readyMerge.map(renderRow).join("")}`
    : "";

  const urgent = visible.filter((u) => u.stage === "needs-human");
  attentionEl.innerHTML = `<h2>Needs attention</h2>${urgent.length ? urgent.map(renderRow).join("") : `<p class="quiet">No open findings, reviewer questions, or blocked PRs require your call.</p>`}`;

  portfolioEl.innerHTML = `<h2>Active branches &amp; pull requests</h2>${visible.length ? visible.map(renderRow).join("") : `<p class="quiet">No active feature branches or open pull requests across this view.</p>`}`;

  document.querySelectorAll(".row").forEach((el) => {
    el.onclick = () => openDetail(state.units.find((u) => u.id === el.dataset.id));
  });
}

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  const projectHealthIssues = (state.projects || []).filter((p) => p.health?.git !== "ok");
  const healthNote = projectHealthIssues.length
    ? ` · Offline repo(s): ${projectHealthIssues.map((p) => p.id).join(", ")}`
    : "";
  freshnessEl.textContent = `Snapshot ${relativeTime(state.generatedAt)}${healthNote}`;
  render();
}

refreshBtn.onclick = async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (res.ok) {
      state = await res.json();
      freshnessEl.textContent = `Snapshot ${relativeTime(state.generatedAt)}`;
      render();
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh battlefield";
  }
};

loadState();

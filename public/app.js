const portfolioRoot = document.querySelector("#portfolio");
const briefRoot = document.querySelector("#workstream-brief");
const repoNav = document.querySelector("#repo-nav");
const freshness = document.querySelector("#freshness");
const health = document.querySelector("#health");
const refreshButton = document.querySelector("#refresh");
const portfolioSort = document.querySelector("#portfolio-sort");
const portfolioSignal = document.querySelector("#portfolio-signal");
const selectionCount = document.querySelector("#selection-count");
const requestAssessmentButton = document.querySelector("#request-assessment");
const newWorkstreamButton = document.querySelector("#new-workstream");
const issuesOpenButton = document.querySelector("#issues-open");
const newWorkstreamDialog = document.querySelector("#new-workstream-dialog");
const newWorkstreamForm = document.querySelector("#new-workstream-form");
const issuesDrawer = document.querySelector("#issues-drawer");
const issuesTitle = document.querySelector("#issues-title");
const issuesRepoTabs = document.querySelector("#issues-repo-tabs");
const issuesFilter = document.querySelector("#issues-filter");
const issuesSummary = document.querySelector("#issues-summary");
const issuesList = document.querySelector("#issues-list");
const workstreamDrawer = document.querySelector("#workstream-drawer");
const evidenceDrawer = document.querySelector("#evidence-drawer");
const evidenceTitle = document.querySelector("#evidence-title");
const evidenceSummary = document.querySelector("#evidence-summary");
const evidenceList = document.querySelector("#evidence-list");

let dashboard = null;
let activeRepo = "all";
let activeStream = null;
let issueRepo = null;
let sortMode = "attention";
const selectedStreams = new Set();

function openWorkstream(streamId) {
  activeStream = streamId;
  renderPortfolio();
  renderBrief();
  if (!workstreamDrawer.open) workstreamDrawer.showModal();
}

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
    if (["past", "superseded"].includes(pr.relation) || pr.state !== "OPEN") return { level: "neutral", label: pr.relation === "superseded" ? "superseded" : String(pr.state || "past").toLowerCase() };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { level: "critical", label: "changes requested" };
    if (pr.reviewDecision === "REVIEW_REQUIRED") return { level: "watch", label: "review required" };
    if (pr.mergeStateStatus === "CLEAN") return { level: "steady", label: "green" };
    if (pr.mergeStateStatus === "BLOCKED") return { level: "watch", label: "merge blocked" };
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

  function attention(stream) {
    if (stream.status === "complete") return { label: "Complete", level: "steady" };
    const activePrs = (stream.prs || []).filter((pr) => !["past", "superseded"].includes(pr.relation) && pr.state === "OPEN");
    const failedChecks = activePrs.some((pr) => (pr.statusCheckRollup || []).some((check) => check.conclusion === "FAILURE" || check.state === "FAILURE"));
    const changesRequested = activePrs.some((pr) => pr.reviewDecision === "CHANGES_REQUESTED");
    const reviewRequired = activePrs.some((pr) => pr.reviewDecision === "REVIEW_REQUIRED" || pr.mergeStateStatus === "BLOCKED");
    if (stream.status === "blocked") return { label: "Blocked", level: "critical" };
    if (failedChecks) return { label: "Checks failing", level: "critical" };
    if (changesRequested) return { label: "Changes requested", level: "critical" };
    if (stream.assessment?.stale) return { label: "Review stale", level: "critical" };
    if (openQuestions(stream).length) return { label: `${openQuestions(stream).length} open question${openQuestions(stream).length === 1 ? "" : "s"}`, level: "watch" };
    if (stream.assessmentRequest?.pending) return { label: "Review requested", level: "watch" };
    if (/authori[sz]ation|user decision|hold/i.test(stream.reviewState || "")) return { label: "Decision needed", level: "watch" };
    if (reviewRequired) return { label: "Review required", level: "watch" };
    if (/exact[- ]head review|review.*pending|pending.*review/i.test(stream.reviewState || "")) return { label: "Review due", level: "watch" };
    if (/\b(required|remains?|blocked|waiting|awaiting)\b/i.test(stream.reviewState || "")) return { label: "Gate pending", level: "watch" };
  return { label: "Clear", level: "steady" };
}

  function delivery(stream) {
    const prs = stream.prs || [];
  if (!prs.length) {
    const completed = (stream.chunks || []).filter((chunk) => chunk.status === "complete").length;
    return `<span class="delivery-main">Pre-PR</span><span class="delivery-sub">${completed}/${(stream.chunks || []).length} milestones complete</span>`;
  }
    const live = prs.filter((pr) => !["past", "superseded"].includes(pr.relation) && pr.state === "OPEN");
    const past = prs.filter((pr) => !live.includes(pr));
    const liveHtml = live.map((pr) => {
      const health = prHealth(pr);
      return `<span class="delivery-main">PR ${pr.number}${pr.current ? " · current" : ""}</span><span class="delivery-sub signal-${health.level}">${escapeHtml(health.label)}</span>`;
    }).join("");
    const pastHtml = past.length ? `<span class="delivery-history">${past.length} past PR${past.length === 1 ? "" : "s"}: ${past.map((pr) => `#${pr.number}`).join(", ")}</span>` : "";
    return liveHtml || pastHtml ? `${liveHtml}${pastHtml}` : `<span class="delivery-main">No active PR</span>`;
  }

function portfolioOwner(stream) {
  const orchestrator = stream.orchestrator || stream.fableAgent;
  const agent = (stream.agents || []).find((candidate) => candidate.id === orchestrator);
  return `<span class="portfolio-owner" data-label="Codex task"><i class="agent-dot"></i><b>${escapeHtml(agent?.name || orchestrator || "Unassigned")}</b><small>${agent ? "assigned" : "not assigned"}</small></span>`;
  }

function nextMilestone(stream) {
  return (stream.chunks || []).find((chunk) => ["blocked", "active", "planned"].includes(chunk.status))?.title || "Outcome delivered";
}

function projectFor(stream) {
  return dashboard.projects.find((project) => project.id === stream.project);
}

  function renderRepoNav() {
  const buttons = [{ id: "all", label: "All workstreams" }, ...dashboard.projects.map((project) => ({ id: project.id, label: project.label }))];
  const project = dashboard.projects.find((candidate) => candidate.id === activeRepo);
  const visibleProjects = project ? [project] : dashboard.projects;
  const activeIssues = visibleProjects.flatMap((item) => item.afIssues || []).filter((issue) => issue.status !== "closed").length;
    repoNav.innerHTML = buttons.map((item) => `<button class="repo-filter ${activeRepo === item.id ? "selected" : ""}" data-repo="${escapeHtml(item.id)}" type="button">${escapeHtml(item.label)}</button>`).join("");
  repoNav.querySelectorAll(".repo-filter").forEach((button) => button.addEventListener("click", () => {
    activeRepo = button.dataset.repo;
    activeStream = null;
    selectedStreams.clear();
    renderDashboard();
  }));
    issuesOpenButton.textContent = `AF issues · ${activeIssues}`;
    issuesOpenButton.onclick = () => {
      issueRepo = activeRepo === "all" ? (issueRepo || dashboard.projects[0]?.id) : activeRepo;
      renderIssueDrawer();
      issuesDrawer.showModal();
    };
}

function commitLinks(commits = [], githubRepo = null) {
  return commits.map((commit) => {
    if (typeof commit !== "string") return `<a href="${escapeHtml(commit.url || "#")}" target="_blank" rel="noreferrer"><code>${escapeHtml(commit.sha.slice(0, 8))}</code></a>`;
    return githubRepo ? `<a href="https://github.com/${escapeHtml(githubRepo)}/commit/${escapeHtml(commit)}" target="_blank" rel="noreferrer"><code>${escapeHtml(commit.slice(0, 8))}</code></a>` : `<code>${escapeHtml(commit.slice(0, 8))}</code>`;
  }).join(" ");
}

function renderIssueDrawer() {
  const project = dashboard.projects.find((candidate) => candidate.id === issueRepo) || dashboard.projects[0];
  if (!project) return;
  issueRepo = project.id;
  const filter = issuesFilter.value;
  const all = project.afIssues || [];
  const roots = all.filter((issue) => !issue.parent_uuid && String(issue.id).split(".").length === 2);
  const childrenFor = (root) => all.filter((issue) => issue.id !== root.id && String(issue.id).startsWith(`${root.id}.`));
  const natural = (left, right) => String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
  roots.sort(natural);
  const visibleRoots = roots.filter((root) => filter === "all" || (filter === "closed" ? root.status === "closed" : root.status !== "closed"));
  const namespaces = [...new Set(visibleRoots.map((issue) => String(issue.id).split(".")[0]))];
  issuesTitle.textContent = `${project.label} issues`;
  issuesSummary.textContent = `${visibleRoots.length} parent issues · ${all.length} total`;
  issuesRepoTabs.innerHTML = dashboard.projects.map((item) => `<button type="button" class="repo-filter ${item.id === project.id ? "selected" : ""}" data-issue-repo="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join("");
  issuesList.innerHTML = visibleRoots.length ? namespaces.map((namespace) => `<section class="issue-namespace"><header><h3>${escapeHtml(namespace)}</h3><span>${visibleRoots.filter((issue) => issue.id.startsWith(`${namespace}.`)).length} parent issues</span></header>${visibleRoots.filter((issue) => issue.id.startsWith(`${namespace}.`)).map((root) => {
    const children = childrenFor(root).sort(natural);
    const direct = children.filter((child) => String(child.id).split(".").length === String(root.id).split(".").length + 1);
    const done = direct.filter((child) => child.status === "closed").length;
    const working = root.status === "in_progress" || children.some((child) => child.status === "in_progress");
    const lane = root.status === "closed" ? "done" : working ? "working" : "on deck";
    const progress = direct.length ? Math.round((done / direct.length) * 100) : root.status === "closed" ? 100 : 0;
    const row = (issue, depth = 0) => `<article class="issue-row depth-${Math.min(3, depth)}"><div class="issue-primary"><span class="issue-status status-${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span><code>${escapeHtml(issue.id)}</code><p>${escapeHtml(issue.title || "Untitled issue")}</p></div><div class="issue-links">${(issue.workstreamIds || []).map((id) => `<button type="button" data-workstream="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join("")}${commitLinks(issue.commits, project.githubRepo)}</div></article>`;
    return `<details class="issue-group lane-${lane.replace(" ", "-")}" ${working ? "open" : ""}><summary><div><span class="lane-label">${lane}</span><code>${escapeHtml(root.id)}</code><b>${escapeHtml(root.title || "Untitled issue")}</b></div><div class="issue-progress"><span>${direct.length ? `${done}/${direct.length} complete` : root.status}</span><i style="--progress:${progress}%"></i></div></summary>${children.map((child) => row(child, String(child.id).split(".").length - String(root.id).split(".").length)).join("")}</details>`;
  }).join("")}</section>`).join("") : `<p class="quiet">No parent issues match this status.</p>`;
  issuesRepoTabs.querySelectorAll("[data-issue-repo]").forEach((button) => button.addEventListener("click", () => { issueRepo = button.dataset.issueRepo; renderIssueDrawer(); }));
  issuesList.querySelectorAll("button[data-workstream]").forEach((button) => button.addEventListener("click", () => {
    issuesDrawer.close();
    openWorkstream(button.dataset.workstream);
  }));
}

  function renderPortfolio() {
    const streams = dashboard.workstreams.filter((stream) => activeRepo === "all" || stream.project === activeRepo);
    const attentionOrder = (stream) => stream.status === "complete" ? 4 : attention(stream).level === "critical" ? 0 : attention(stream).level === "watch" ? 1 : 2;
    const updatedOrder = (left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
    const sorted = [...streams].sort((a, b) => {
      if (sortMode === "updated") return updatedOrder(a, b);
      if (sortMode === "agent") {
        const leftAgent = a.orchestrator || a.fableAgent || "~unassigned";
        const rightAgent = b.orchestrator || b.fableAgent || "~unassigned";
        return leftAgent.localeCompare(rightAgent, undefined, { sensitivity: "base" }) || updatedOrder(a, b);
      }
      return attentionOrder(a) - attentionOrder(b) || updatedOrder(a, b);
    });
    const needingAttention = streams.filter((stream) => attention(stream).level !== "steady" && stream.status !== "complete").length;
    const active = streams.filter((stream) => ["active", "blocked"].includes(stream.status)).length;
    portfolioSignal.textContent = `${streams.length} outcomes · ${needingAttention} need attention · ${active} active · ${streams.filter((stream) => stream.status === "complete").length} complete`;
    portfolioSort.querySelectorAll("button[data-sort]").forEach((button) => {
      const selected = button.dataset.sort === sortMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  const selectionSize = selectedStreams.size;
  selectionCount.textContent = selectionSize ? `${selectionSize} outcome${selectionSize === 1 ? "" : "s"} selected for a native Codex review brief.` : "Select outcomes to prepare native Codex review briefs.";
  requestAssessmentButton.disabled = selectionSize === 0;
  requestAssessmentButton.textContent = selectionSize ? `Prepare review brief · ${selectionSize}` : "Prepare review brief";

  portfolioRoot.innerHTML = `<div class="portfolio-header" aria-hidden="true">
      <span></span><span>Outcome</span><span>Agent</span><span>Needs attention</span><span>Current gate</span><span>Delivery</span><span>Updated</span>
  </div>${sorted.map((stream) => {
    const attentionState = attention(stream);
    const selected = activeStream === stream.id;
    return `<div class="portfolio-row ${selected ? "selected" : ""} ${stream.status === "complete" ? "is-complete" : ""}" data-stream="${escapeHtml(stream.id)}">
      <input class="stream-select" type="checkbox" aria-label="Select ${escapeHtml(stream.title)} for assessment" ${selectedStreams.has(stream.id) ? "checked" : ""}>
      <button class="row-open" type="button" aria-pressed="${selected}">
          <span class="outcome"><b>${escapeHtml(stream.title)}</b><small>${escapeHtml(phase(stream))} · ${escapeHtml(nextMilestone(stream))}</small></span>
          ${portfolioOwner(stream)}
        <span data-label="Needs attention" class="signal-${attentionState.level}">${escapeHtml(attentionState.label)}</span>
        <span data-label="Current gate" class="current-gate">${escapeHtml(stream.reviewState || "No gate recorded")}</span>
        <span data-label="Delivery" class="delivery">${delivery(stream)}</span>
        <span data-label="Updated">${relativeTime(stream.updatedAt)}</span>
      </button>
    </div>`;
  }).join("")}`;
    portfolioRoot.querySelectorAll(".portfolio-row").forEach((row) => {
    row.querySelector(".stream-select").addEventListener("change", (event) => {
      if (event.currentTarget.checked) selectedStreams.add(row.dataset.stream); else selectedStreams.delete(row.dataset.stream);
      renderPortfolio();
    });
    row.querySelector(".row-open").addEventListener("click", () => {
      openWorkstream(row.dataset.stream);
    });
    });
    portfolioSort.querySelectorAll("button[data-sort]").forEach((button) => { button.onclick = () => {
      sortMode = button.dataset.sort;
      renderPortfolio();
    }; });
  }

function renderLinkedEvidence(stream) {
  const project = projectFor(stream);
  const issues = (project?.afIssues || []).filter((issue) => (issue.workstreamIds || []).includes(stream.id));
  const references = stream.references || [];
  return `<section class="linked-evidence"><div><div class="subhead"><h3>AF issue tree</h3><span>${issues.filter((issue) => issue.status !== "closed").length} active · ${issues.length} linked</span></div>${issues.length ? `<ul class="linked-issues">${issues.slice(0, 24).map((issue) => `<li><span class="issue-status status-${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span><code>${escapeHtml(issue.id)}</code><span>${escapeHtml(issue.title)}</span>${issue.commits?.length ? `<small>${commitLinks(issue.commits)}</small>` : ""}</li>`).join("")}</ul>` : `<p class="quiet">No AF issues are explicitly linked.</p>`}</div><div><div class="subhead"><h3>Git references</h3><span>${references.length} pointed source${references.length === 1 ? "" : "s"}</span></div>${references.length ? `<ul class="reference-list">${references.map((reference) => `<li><p><span>${escapeHtml(reference.kind || "plan")}</span>${reference.url ? `<a href="${escapeHtml(reference.url)}" target="_blank" rel="noreferrer">${escapeHtml(reference.label || reference.path)}</a>` : `<b>${escapeHtml(reference.label || reference.path)}</b>`}${reference.exists === false ? `<em>missing at current revision</em>` : ""}</p>${reference.quote ? `<blockquote>${escapeHtml(reference.quote)}</blockquote>` : ""}<small><code>${escapeHtml(reference.path)}</code>${reference.commit ? ` · ${escapeHtml(reference.commit.slice(0, 8))}` : ""}</small></li>`).join("")}</ul>` : `<p class="quiet">No git plan or contract is material to this workstream.</p>`}</div></section>`;
}

function renderAgents(stream) {
  const orchestrator = stream.orchestrator || stream.fableAgent;
  const agent = (stream.agents || []).find((candidate) => candidate.id === orchestrator);
  return `<span><i class="agent-dot"></i>Orchestrator: ${escapeHtml(agent?.name || orchestrator || "unassigned")}</span>`;
}

function humanize(value) {
  return value ? String(value).replaceAll("_", " ") : "Pending";
}

function renderJudgment(assessment) {
  const fields = [
    ["Outcome confidence", assessment.outcomeConfidence == null ? "Pending" : `${assessment.outcomeConfidence}%`],
    ["Necessity", humanize(assessment.necessity)],
    ["Simpler path", humanize(assessment.simplerPath)],
    ["Scope drift", humanize(assessment.scopeDrift)],
    ["Contract integrity", humanize(assessment.contractIntegrity)],
    ["Evidence quality", humanize(assessment.evidenceQuality)]
  ];
  return `<dl class="judgment-grid">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function renderTimeline(stream) {
  const remaining = (stream.chunks || []).filter((chunk) => chunk.status !== "complete");
  const events = [...(stream.timeline || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const remainingHtml = remaining.length ? `<div class="timeline-remaining"><p class="timeline-label">Remaining</p><ol>${remaining.map((chunk) => `<li class="milestone-${escapeHtml(chunk.status)}"><span class="milestone-mark"></span><div><b>${escapeHtml(chunk.title)}</b><small>${escapeHtml(chunk.status)}${chunk.issueIds?.length ? ` · ${chunk.issueIds.map((id) => escapeHtml(id)).join(", ")}` : ""}</small></div></li>`).join("")}</ol></div>` : `<p class="timeline-complete">Delivery chain complete</p>`;
  const history = events.length ? `<ol class="movement-list">${events.map((event) => `<li>
    <time datetime="${escapeHtml(event.at)}">${new Date(event.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
    <span class="timeline-node timeline-${escapeHtml(event.type || "event")}"></span>
    <div><p><b>${escapeHtml(event.label)}</b><span>${escapeHtml(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(event.actor || "") ? "agent session" : (event.actor || "system"))}</span></p><p>${escapeHtml(event.text)}</p></div>
  </li>`).join("")}</ol>` : `<p class="quiet movement-empty">No structured execution events have been recorded yet.</p>`;
  return `${remainingHtml}<div class="timeline-divider"><span>Recorded movement</span></div>${history}`;
}

function reviewEvents(stream) {
  return stream.reviewPasses || [];
}

  function primaryPr(stream) {
    return (stream.prs || []).find((pr) => pr.current) || (stream.prs || []).find((pr) => pr.state === "OPEN") || null;
}

function renderReviewSummary(stream) {
  const pr = primaryPr(stream);
  const assessment = stream.assessment || {};
  const reviews = reviewEvents(stream);
  const questions = openQuestions(stream);
  const activeIssueCount = (stream.afIssues || []).filter((issue) => issue.status !== "closed").length;
  const head = pr?.headRefOid || assessment.currentHead || null;
  const passes = reviews.filter((event) => event.type === "review_pass");
  const currentPasses = passes.filter((event) => head && String(event.metadata?.head || "").toLowerCase() === String(head).toLowerCase());
  const invalidatedPasses = passes.length - currentPasses.length;
  const unresolvedFindings = currentPasses.flatMap((event) => event.metadata?.unresolved || []).length;
  const stale = Boolean(assessment.stale || (head && assessment.assessedHead && !head.startsWith(assessment.assessedHead) && !assessment.assessedHead.startsWith(head)));
  const verdict = assessment.mergeReadiness == null ? "Reviewer judgment pending" : `${assessment.assessedBy || "Reviewer"}: ${assessment.mergeReadiness}% merge-ready · ${assessment.structuralRisk == null ? "structural risk pending" : `${assessment.structuralRisk}% rebuild risk`}`;
  const lines = [
    ["reviews", passes.length ? `${currentPasses.length} independent pass${currentPasses.length === 1 ? "" : "es"} on current head${invalidatedPasses ? ` · ${invalidatedPasses} superseded` : ""}` : "No exact-SHA review pass recorded"],
    ["assessment", stale ? "Latest assessment predates the current head" : verdict],
    ["considerations", questions.length || unresolvedFindings ? `${questions.length + unresolvedFindings} unresolved consideration${questions.length + unresolvedFindings === 1 ? "" : "s"}` : "No unresolved considerations"],
    ["issues", `${activeIssueCount} active AF issue${activeIssueCount === 1 ? "" : "s"}`],
    ["context", `${(stream.references || []).length} governing git reference${(stream.references || []).length === 1 ? "" : "s"}`],
    ["reconciliation", stream.assessmentRequest?.pending ? `Reconciliation pending with ${stream.assessmentRequest.requestedFrom || "reviewer"}` : "No reviewer reconciliation queued"]
  ];
  return `<section class="review-summary"><p class="review-head">${pr ? `<a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">PR #${pr.number}</a>` : "Pre-PR branch"} · head <code>${escapeHtml(head ? head.slice(0, 8) : "unrecorded")}</code></p><div class="review-lines">${lines.map(([mode, text]) => `<button type="button" data-evidence="${mode}"><span>${escapeHtml(text)}</span><i aria-hidden="true">↗</i></button>`).join("")}</div></section>`;
}

function openEvidence(stream, mode) {
  const assessment = stream.assessment || {};
  const project = projectFor(stream);
  const reviews = reviewEvents(stream);
  const questions = openQuestions(stream);
  const issues = stream.afIssues || [];
  const content = {
    reviews: ["Review passes", `${reviews.length} structured judgment event${reviews.length === 1 ? "" : "s"}. Ledger passes include exact reviewer, model, verdict, and reviewed SHA.`, reviews.length ? `<ol class="drawer-events">${reviews.map((event) => `<li><time>${new Date(event.at).toLocaleString()}</time><b>${escapeHtml(event.metadata?.verdict || event.label)}</b><span>${escapeHtml(event.metadata?.model || event.actor)}</span><p>${escapeHtml(event.text)}</p>${event.metadata?.head ? `<small>head <code>${escapeHtml(event.metadata.head.slice(0, 8))}</code> · ${event.metadata.independent ? "independent" : "reconciliation"}</small>` : ""}</li>`).join("")}</ol>` : `<p class="quiet">No structured reviewer events yet.</p>`],
    assessment: ["Current judgment", assessment.stale ? "This judgment is stale because the branch head moved." : "Latest reviewer-owned readiness and structural-risk judgment.", `${renderJudgment(assessment)}${assessment.rationale ? `<p class="rationale">${escapeHtml(assessment.rationale)}</p>` : `<p class="quiet">Assessment pending.</p>`}`],
    considerations: ["Open considerations", `${questions.length} unresolved question${questions.length === 1 ? "" : "s"}.`, questions.length ? `<ul class="drawer-questions">${questions.map((question) => `<li><code>${escapeHtml(question.id)}</code><p>${escapeHtml(question.text)}</p><small>Raised ${relativeTime(question.askedAt)}</small></li>`).join("")}</ul>` : `<p class="quiet">Nothing unresolved.</p>`],
    issues: ["Linked AF issues", `${issues.filter((issue) => issue.status !== "closed").length} active of ${issues.length} linked.`, issues.length ? `<div>${issues.map((issue) => `<article class="issue-row"><div class="issue-primary"><span class="issue-status status-${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span><code>${escapeHtml(issue.id)}</code><p>${escapeHtml(issue.title)}</p></div>${issue.commits?.length ? `<div class="issue-links">${commitLinks(issue.commits, project?.githubRepo)}</div>` : ""}</article>`).join("")}</div>` : `<p class="quiet">No AF issues linked.</p>`],
    context: ["Governing git context", `${(stream.references || []).length} pointed reference${(stream.references || []).length === 1 ? "" : "s"}. Git remains the source of truth.`, (stream.references || []).length ? `<ul class="reference-list">${stream.references.map((reference) => `<li><p><span>${escapeHtml(reference.kind || "plan")}</span>${reference.url ? `<a href="${escapeHtml(reference.url)}" target="_blank" rel="noreferrer">${escapeHtml(reference.label || reference.path)}</a>` : `<b>${escapeHtml(reference.label || reference.path)}</b>`}</p>${reference.quote ? `<blockquote>${escapeHtml(reference.quote)}</blockquote>` : ""}<small><code>${escapeHtml(reference.path)}</code>${reference.commit ? ` · ${escapeHtml(reference.commit.slice(0, 8))}` : ""}</small></li>`).join("")}</ul>` : `<p class="quiet">No governing reference is linked.</p>`],
    reconciliation: ["Reviewer reconciliation", stream.assessmentRequest?.pending ? `Requested ${relativeTime(stream.assessmentRequest.requestedAt)} from ${stream.assessmentRequest.requestedFrom || "reviewer"}.` : "No reviewer response is currently queued.", stream.assessmentRequest?.pending ? `<p>${escapeHtml(stream.assessmentRequest.prompt || "A fresh evidence-backed judgment has been requested.")}</p>` : `<p class="quiet">The latest structured judgment is reflected in the field report.</p>`]
  }[mode];
  evidenceTitle.textContent = content[0];
  evidenceSummary.textContent = content[1];
  evidenceList.innerHTML = content[2];
  evidenceDrawer.showModal();
}

function renderBrief() {
  const stream = dashboard.workstreams.find((candidate) => candidate.id === activeStream);
  if (!stream) {
    briefRoot.innerHTML = "";
    return;
  }
  const project = projectFor(stream);
  const attentionState = attention(stream);
  const issues = (stream.afIssues || []).filter((issue) => issue.status !== "closed");
  const orchestrator = stream.orchestrator || stream.fableAgent;
  const agent = (stream.agents || []).find((candidate) => candidate.id === orchestrator);
  briefRoot.innerHTML = `<article class="brief">
    <header class="brief-head">
      <div><p class="kicker">${escapeHtml(project?.label || stream.project)} · ${phase(stream)}</p><h2>${escapeHtml(stream.title)}</h2></div>
      <div class="brief-actions"><button class="request-one" type="button">Prepare review brief</button><button class="close-brief" type="button" aria-label="Close workstream brief">Close</button></div>
    </header>
    <div class="situation">
      <p>${escapeHtml(stream.summary)}</p>
      <dl>
        <div><dt>Current gate</dt><dd>${escapeHtml(stream.reviewState || "No gate recorded")}</dd></div>
        <div><dt>Next milestone</dt><dd>${escapeHtml(nextMilestone(stream))}</dd></div>
        <div><dt>Needs attention</dt><dd class="signal-${attentionState.level}">${escapeHtml(attentionState.label)}</dd></div>
        <div><dt>Owner</dt><dd>${escapeHtml(agent?.name || orchestrator || "Unassigned")}</dd></div>
      </dl>
    </div>
    ${renderReviewSummary(stream)}
    <section class="delivery-ledger"><div class="subhead"><h3>Semantic timeline</h3><span>${(stream.timeline || []).length} recorded · ${(stream.chunks || []).filter((chunk) => chunk.status !== "complete").length} remaining</span></div>${renderTimeline(stream)}</section>
    <footer class="evidence">
      <div><b>Evidence</b><span>${escapeHtml(stream.branch || "No branch")} · ${issues.length} open AF issue${issues.length === 1 ? "" : "s"} · ${(stream.references || []).length} governing reference${(stream.references || []).length === 1 ? "" : "s"} · updated ${relativeTime(stream.updatedAt)}</span>${stream.commits?.length ? `<span>${commitLinks(stream.commits, project?.githubRepo)}</span>` : ""}</div>
      <div class="agents">${renderAgents(stream)}</div>
      <details class="session-editor"><summary>Orchestrator binding</summary><form data-workstream-id="${escapeHtml(stream.id)}">
      <label>Codex task alias or UUID<input name="orchestrator" value="${escapeHtml(agent?.name || orchestrator || "")}"></label>
        <button type="submit">Save</button><span class="save-status" aria-live="polite"></span>
      </form></details>
    </footer>
  </article>`;
  briefRoot.querySelector(".close-brief").addEventListener("click", () => workstreamDrawer.close());
  briefRoot.querySelector(".request-one").addEventListener("click", () => requestAssessments([stream.id]));
  briefRoot.querySelectorAll("[data-evidence]").forEach((button) => button.addEventListener("click", () => openEvidence(stream, button.dataset.evidence)));
  briefRoot.querySelector("form").addEventListener("submit", saveSessions);
}

function renderDashboard() {
  renderRepoNav();
  renderPortfolio();
  renderBrief();
  freshness.textContent = `Snapshot ${new Date(dashboard.generatedAt).toLocaleString()} · ${relativeTime(dashboard.generatedAt)}`;
  health.textContent = JSON.stringify(dashboard.health, null, 2);
  newWorkstreamForm.elements.project.innerHTML = dashboard.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.label)}</option>`).join("");
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

async function requestAssessments(workstreamIds) {
  requestAssessmentButton.disabled = true;
  const briefButton = briefRoot.querySelector(".request-one");
  if (briefButton) briefButton.disabled = true;
    selectionCount.textContent = `Preparing ${workstreamIds.length} native Codex review brief${workstreamIds.length === 1 ? "" : "s"}…`;
  try {
    const response = await fetch("/api/assessments/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workstreamIds }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Assessment request failed");
      const briefs = result.requested.map((brief) => `Advisory assessment brief\nWorkstream: ${brief.id}\nHead: ${brief.head}\n\n${brief.prompt}`).join("\n\n---\n\n");
      await navigator.clipboard.writeText(briefs);
      selectedStreams.clear();
      selectionCount.textContent = `Copied ${result.requested.length} native Codex review brief${result.requested.length === 1 ? "" : "s"}.`;
      requestAssessmentButton.disabled = true;
  } catch (error) {
    selectionCount.textContent = error.message;
    requestAssessmentButton.disabled = selectedStreams.size === 0;
    if (briefButton) briefButton.disabled = false;
  }
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

requestAssessmentButton.addEventListener("click", () => requestAssessments([...selectedStreams]));

newWorkstreamButton.addEventListener("click", () => newWorkstreamDialog.showModal());
newWorkstreamDialog.querySelector(".dialog-close").addEventListener("click", () => newWorkstreamDialog.close());
issuesDrawer.querySelector(".issues-close").addEventListener("click", () => issuesDrawer.close());
evidenceDrawer.querySelector(".evidence-close").addEventListener("click", () => evidenceDrawer.close());
workstreamDrawer.addEventListener("close", () => {
  activeStream = null;
  briefRoot.innerHTML = "";
  if (dashboard) renderPortfolio();
});
issuesFilter.addEventListener("change", renderIssueDrawer);
newWorkstreamForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  const status = form.querySelector(".form-status");
  submit.disabled = true;
  status.textContent = "Creating…";
  try {
    const values = Object.fromEntries(new FormData(form));
    const response = await fetch("/api/workstreams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create outcome");
    form.reset();
    newWorkstreamDialog.close();
    activeRepo = result.workstream.project;
    await load();
    openWorkstream(result.workstream.id);
  } catch (error) { status.textContent = error.message; } finally { submit.disabled = false; }
});

load().catch((error) => { freshness.textContent = error.message; });

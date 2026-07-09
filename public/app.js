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

function renderStream(stream, project) {
  const ageHours = stream.updatedAt ? (Date.now() - new Date(stream.updatedAt).getTime()) / 36e5 : Infinity;
  const stale = stream.status === "active" && ageHours > 12;
  const chunks = (stream.chunks || []).map((chunk) => `
    <li class="${escapeHtml(chunk.status)}">
      <span class="mark" aria-hidden="true">${marks[chunk.status] || "□"}</span>
      <span>${escapeHtml(chunk.title)}</span>
    </li>`).join("");
  const prs = (stream.prs || []).length
    ? stream.prs.map((pr) => pr.url ? `<a href="${escapeHtml(pr.url)}">#${pr.number}</a>` : `#${pr.number}`).join(", ")
    : "No associated PRs";
  return `
    <article class="stream">
      <div class="stream-head">
        <div><p class="project">${escapeHtml(project?.label || stream.project)}</p><h3>${escapeHtml(stream.title)}</h3></div>
        <span class="status ${escapeHtml(stream.status)}">${escapeHtml(stream.status)}</span>
      </div>
      <p class="summary">${escapeHtml(stream.summary)}</p>
      <ul class="chunks" aria-label="Work chunks">${chunks}</ul>
      <div class="stream-foot">
        <div class="agents">
          <span>Fable: ${escapeHtml(stream.fableAgent || "unassigned")}</span>
          <span>Reviewer: ${escapeHtml(stream.reviewerAgent || "shared / unassigned")}</span>
          <span>Codex: ${escapeHtml(stream.codexExecutor || "unassigned")}</span>
          <span class="${stale ? "stale" : ""}">${stale ? "Stale · " : ""}updated ${relativeTime(stream.updatedAt)}</span>
        </div>
        <div class="prs">${prs}</div>
      </div>
    </article>`;
}

function render(data) {
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const rank = { blocked: 0, active: 1, planned: 2, complete: 3 };
  const streams = [...data.workstreams].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  streamsRoot.innerHTML = streams.map((stream) => renderStream(stream, projects.get(stream.project))).join("");

  const attention = streams.flatMap((stream) => {
    const items = (stream.questions || []).filter((question) => question.status === "open").map((question) => ({ stream, label: `Open question ${question.id}`, text: question.text }));
    if (stream.status === "blocked" && !items.length) items.push({ stream, label: "Blocked", text: "The workstream is blocked but has no open question recorded." });
    return items;
  });
  attentionCount.textContent = `${attention.length}`;
  attentionRoot.innerHTML = attention.map(({ stream, label, text }) => `
    <div class="attention-item"><strong>${escapeHtml(stream.title)} · ${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>`).join("");
  freshness.textContent = `Sources refreshed ${relativeTime(data.generatedAt)} · ${new Date(data.generatedAt).toLocaleString()}`;
  health.textContent = JSON.stringify(data.health, null, 2);
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

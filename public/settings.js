const seatsEl = document.querySelector("#seats");
// Tabs: #models (default) and #projects.
function showTab() {
  const active = location.hash === "#projects" ? "projects" : "models";
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== `tab-${active}`;
  for (const link of document.querySelectorAll(".tabs a")) link.setAttribute("aria-selected", String(link.dataset.tab === active));
}
addEventListener("hashchange", showTab);
showTab();

const HOME_LABELS = { repo: "Repository (docs/plans/)", linear: "Linear", notion: "Notion", ref: "Ref" };
const statusEl = document.querySelector("#status");
const sourceEl = document.querySelector("#source");
let roles = [];
let purposes = {};
let launchers = [];
let seats = {};

const escape = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function status(text, kind = "") { statusEl.textContent = text; statusEl.className = kind; }

function load(data) {
  roles = data.roles || roles;
  purposes = data.purposes || purposes;
  launchers = data.launchers || launchers;
  const raw = data.raw || { seats: {} };
  seats = Object.fromEntries(roles.map((role) => [role, (raw.seats?.[role]?.models || []).map((model) => ({ id: model.id || "", launch: model.launch || launchers[0], cliModel: model.cliModel || "" }))]));
  sourceEl.textContent = data.exists ? `Editing ${data.path}` : `No config at ${data.path} yet. These are the shipped defaults; Save creates the file.`;
  render();
  if (data.error) status(`The file on disk has a problem: ${data.error}`, "warn");
}


function render() {
  seatsEl.innerHTML = roles.map((role) => `
    <h3>${escape(role)}</h3>
    <p class="quiet">${escape(purposes[role] || "")}</p>
    <table>
      <thead><tr><th></th><th>Model id</th><th>Launch</th><th>CLI model (optional)</th><th></th></tr></thead>
      <tbody>${seats[role].map((model, index) => `
        <tr data-role="${escape(role)}" data-index="${index}">
          <td class="quiet">${index === 0 ? "default" : "fallback"}</td>
          <td><input data-field="id" list="ids-${escape(model.launch)}" value="${escape(model.id)}" placeholder="e.g. claude-opus-5-5" aria-label="Model id"></td>
          <td><select data-field="launch" aria-label="Launch">${launchers.map((launch) => `<option ${launch === model.launch ? "selected" : ""}>${escape(launch)}</option>`).join("")}</select></td>
          <td><input data-field="cliModel" list="cli-${escape(model.launch)}" value="${escape(model.cliModel)}" placeholder="same as id" aria-label="CLI model"></td>
          <td class="actions">
            <button data-action="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button data-action="down" ${index === seats[role].length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button data-action="remove" aria-label="Remove">Remove</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>
    <button data-action="add" data-role="${escape(role)}">Add model</button>`).join("");
}

seatsEl.addEventListener("input", (event) => {
  const row = event.target.closest("tr[data-role]");
  if (!row || !event.target.dataset.field) return;
  const model = seats[row.dataset.role][Number(row.dataset.index)];
  model[event.target.dataset.field] = event.target.value;
  // Suggestions follow the launch; picking a suggested id fills its CLI model.
  if (event.target.dataset.field === "launch") return render();
  if (event.target.dataset.field === "id") {
    // Fill the CLI model from a suggestion, and drop one filled for an earlier id.
    const known = suggestions[model.launch] || [];
    const match = known.find((item) => item.id === model.id && item.cliModel);
    const wasSuggested = known.some((item) => item.cliModel === model.cliModel);
    if (match && (!model.cliModel || wasSuggested)) model.cliModel = match.cliModel;
    else if (!match && wasSuggested) model.cliModel = "";
    row.querySelector('[data-field="cliModel"]').value = model.cliModel;
  }
});

let suggestions = {};
async function loadSuggestions() {
  const response = await fetch("/api/models");
  const data = await response.json();
  if (!response.ok) return;
  suggestions = data.byLaunch;
  for (const [launch, models] of Object.entries(suggestions)) {
    const ids = [...new Set(models.map((model) => model.id))];
    document.querySelector(`#ids-${launch}`).innerHTML = ids.map((id) => `<option value="${escape(id)}">`).join("");
    document.querySelector(`#cli-${launch}`).innerHTML = [...new Set(models.map((model) => model.cliModel).filter(Boolean))].map((id) => `<option value="${escape(id)}">`).join("");
  }
  if (data.cursorError) sourceEl.textContent += ` Cursor model suggestions unavailable: ${data.cursorError}.`;
}

seatsEl.addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  if (action === "add") { seats[event.target.dataset.role].push({ id: "", launch: launchers[0], cliModel: "" }); return render(); }
  const row = event.target.closest("tr[data-role]");
  const list = seats[row.dataset.role];
  const index = Number(row.dataset.index);
  if (action === "remove") list.splice(index, 1);
  if (action === "up") [list[index - 1], list[index]] = [list[index], list[index - 1]];
  if (action === "down") [list[index + 1], list[index]] = [list[index], list[index + 1]];
  render();
});

function draft() {
  const raw = { schemaVersion: 1, seats: {} };
  for (const role of roles) {
    raw.seats[role] = { models: seats[role].map((model) => {
      const entry = { id: model.id.trim(), launch: model.launch };
      if (model.cliModel.trim() && model.cliModel.trim() !== entry.id) entry.cliModel = model.cliModel.trim();
      return entry;
    }) };
  }
  return raw;
}

async function save() {
  status("Saving…");
  const response = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft()) });
  const data = await response.json();
  if (!response.ok) { status(`Not saved: ${data.error}`, "warn"); return statusEl.scrollIntoView({ block: "nearest" }); }
  load({ ...data, roles, purposes, launchers });
  status("Saved. New review briefs use these models; recorded reviews keep theirs.", "good");
  statusEl.scrollIntoView({ block: "nearest" });
}
for (const button of document.querySelectorAll(".save")) button.addEventListener("click", save);

const response = await fetch("/api/config");
const data = await response.json();
if (!response.ok) status(data.error, "warn"); else load(data);

// Projects
const projectsEl = document.querySelector("#project-list");
const projectStatusEl = document.querySelector("#project-status");
let projects = [];
let planHomes = [];

function projectStatus(text, kind = "") { projectStatusEl.textContent = text; projectStatusEl.className = kind; }

function renderProjects() {
  if (!projects.length) { projectsEl.innerHTML = `<p class="quiet">No projects yet. Add one with <code>fr project add</code>.</p>`; return; }
  projectsEl.innerHTML = projects.map((project) => `
    <div class="project" data-id="${escape(project.id)}">
      <div class="project-head">
        <strong>${escape(project.id)}</strong>
        <small class="${project.repoExists ? "quiet" : "warn"}">${escape(project.repoPath)}${project.repoExists ? "" : " — folder not found"}</small>
        <small class="quiet">${project.workstreams} workstream${project.workstreams === 1 ? "" : "s"}</small>
      </div>
      <div class="project-fields">
        <label>GitHub repo <input data-field="githubRepo" value="${escape(project.githubRepo || "")}" placeholder="owner/name"></label>
        <label>Base branch <input data-field="baseBranch" value="${escape(project.baseBranch || "main")}"></label>
        <label>Todos go to <select data-field="kind"><option value="af" ${project.tracker.kind === "af" ? "selected" : ""}>AF issues</option><option value="linear" ${project.tracker.kind === "linear" ? "selected" : ""}>Linear</option></select></label>
        <label class="linear-only" ${project.tracker.kind === "linear" ? "" : "hidden"}>Linear team <input data-field="team" value="${escape(project.tracker.team || "")}" placeholder="e.g. ENG"></label>
        <label class="linear-only" ${project.tracker.kind === "linear" ? "" : "hidden"}>Linear label <input data-field="label" value="${escape(project.tracker.label || "")}" placeholder="optional"></label>
      </div>
      <div class="project-fields plans-fields">
        <label>Plans live in <select data-field="planHome">${planHomes.map((home) => `<option value="${escape(home)}" ${home === project.plans.home ? "selected" : ""}>${escape(HOME_LABELS[home] || home)}</option>`).join("")}</select></label>
        <label class="plan-reference" ${project.plans.home === "repo" ? "hidden" : ""}>Plan reference <input data-field="planReference" value="${escape(project.plans.reference || "")}" placeholder="team, page, or parent document (optional)"></label>
      </div>
      <div class="project-actions"><button data-action="save-project">Save project</button><button data-action="remove-project">Remove</button></div>
    </div>`).join("");
}

projectsEl.addEventListener("change", (event) => {
  const card = event.target.closest(".project");
  if (event.target.dataset.field === "kind") for (const label of card.querySelectorAll(".linear-only")) label.hidden = event.target.value !== "linear";
  // A repository plan has no reference: it always goes in docs/plans/.
  if (event.target.dataset.field === "planHome") {
    const repo = event.target.value === "repo";
    card.querySelector(".plan-reference").hidden = repo;
    if (repo) card.querySelector('[data-field="planReference"]').value = "";
  }
});

async function projectRequest(path, payload, done) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) return projectStatus(`Not saved: ${data.error}`, "warn");
  projects = data.projects;
  planHomes = data.planHomes || planHomes;
  renderProjects();
  projectStatus(done, "good");
}

projectsEl.addEventListener("click", async (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  const card = event.target.closest(".project");
  const project = projects.find((item) => item.id === card.dataset.id);
  const value = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
  if (action === "remove-project") {
    const extra = project.workstreams ? ` and its ${project.workstreams} workstream${project.workstreams === 1 ? "" : "s"} with their review records` : "";
    if (!confirm(`Remove ${project.id}${extra}? This cannot be undone.`)) return;
    return projectRequest("/api/projects/remove", { id: project.id, withWorkstreams: true, expectedWorkstreams: project.workstreams }, `Removed ${project.id}.`);
  }
  const kind = value("kind");
  const tracker = kind === "linear" ? (value("label") ? { kind, team: value("team"), label: value("label") } : { kind, team: value("team"), clearLabel: true }) : { kind };
  const plans = value("planReference") ? { home: value("planHome"), reference: value("planReference") } : { home: value("planHome"), clearReference: true };
  return projectRequest("/api/projects/update", { id: project.id, githubRepo: value("githubRepo"), baseBranch: value("baseBranch"), tracker, plans }, `Saved ${project.id}.`);
});

const projectResponse = await fetch("/api/projects");
const projectData = await projectResponse.json();
if (projectResponse.ok) { projects = projectData.projects; planHomes = projectData.planHomes; renderProjects(); } else projectStatus(projectData.error, "warn");
loadSuggestions();

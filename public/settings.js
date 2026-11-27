const seatsEl = document.querySelector("#seats");
// Tabs: #models (default) and #projects.
function showTab() {
  const active = location.hash === "#projects" ? "projects" : "models";
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== `tab-${active}`;
  for (const link of document.querySelectorAll(".tabs a")) link.setAttribute("aria-selected", String(link.dataset.tab === active));
}
addEventListener("hashchange", showTab);
showTab();

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
  seats = Object.fromEntries(roles.map((role) => [role, (Array.isArray(raw.seats?.[role]?.models) ? raw.seats[role].models : []).filter((model) => model && typeof model === "object").map((model) => ({ id: model.id || "", launch: model.launch || launchers[0], cliModel: model.cliModel || "" }))]));
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
  // CLI model names belong to one launcher; a new launcher starts from the id.
  if (event.target.dataset.field === "launch") { model.cliModel = ""; return render(); }
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
let todoServices = [];
let planServices = [];
const SERVICE_LABELS = { github: "GitHub Issues", linear: "Linear", notion: "Notion", ref: "Ref", repo: "Repository (docs/plans/)" };
// Each service's location is free text; the placeholder says what it means there.
const TODO_PLACEHOLDERS = { github: "owner/repo, label (blank: this project's repo)", linear: "team and label, e.g. ENG, agent-todo", notion: "database or page", ref: "parent ref" };
const PLAN_PLACEHOLDERS = { linear: "team or project", notion: "page or database", ref: "parent ref" };
const serviceSelect = (field, services, current) => `<select data-field="${field}">${services.map((service) => `<option value="${escape(service)}" ${service === current ? "selected" : ""}>${escape(SERVICE_LABELS[service] || service)}</option>`).join("")}</select>`;

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
        <label>Todos go to ${serviceSelect("todoService", todoServices, project.todos.service)}</label>
        <label class="todo-reference">Todo location <input data-field="todoReference" value="${escape(project.todos.reference || "")}" placeholder="${escape(TODO_PLACEHOLDERS[project.todos.service] || "")}"></label>
      </div>
      <div class="project-fields plans-fields">
        <label>Plans live in ${serviceSelect("planService", planServices, project.plans.service)}</label>
        <label class="plan-reference" ${project.plans.service === "repo" ? "hidden" : ""}>Plan location <input data-field="planReference" value="${escape(project.plans.reference || "")}" placeholder="${escape(PLAN_PLACEHOLDERS[project.plans.service] || "")}"></label>
      </div>
      <div class="project-actions"><button data-action="save-project">Save project</button><button data-action="remove-project">Remove</button></div>
    </div>`).join("");
}

projectsEl.addEventListener("change", (event) => {
  const card = event.target.closest(".project");
  const field = event.target.dataset.field;
  // A new service means a new location; a repository plan has none.
  if (field === "todoService") {
    const input = card.querySelector('[data-field="todoReference"]');
    input.value = "";
    input.placeholder = TODO_PLACEHOLDERS[event.target.value] || "";
  }
  if (field === "planService") {
    const input = card.querySelector('[data-field="planReference"]');
    input.value = "";
    input.placeholder = PLAN_PLACEHOLDERS[event.target.value] || "";
    card.querySelector(".plan-reference").hidden = event.target.value === "repo";
  }
});

async function projectRequest(path, payload, done) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) return projectStatus(`Not saved: ${data.error}`, "warn");
  projects = data.projects;
  todoServices = data.todoServices || todoServices;
  planServices = data.planServices || planServices;
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
  const destination = (service, reference) => (value(reference) ? { service: value(service), reference: value(reference) } : { service: value(service), clearReference: true });
  return projectRequest("/api/projects/update", { id: project.id, githubRepo: value("githubRepo"), baseBranch: value("baseBranch"), todos: destination("todoService", "todoReference"), plans: destination("planService", "planReference") }, `Saved ${project.id}.`);
});

const projectResponse = await fetch("/api/projects");
const projectData = await projectResponse.json();
if (projectResponse.ok) { projects = projectData.projects; todoServices = projectData.todoServices; planServices = projectData.planServices; renderProjects(); } else projectStatus(projectData.error, "warn");
loadSuggestions();

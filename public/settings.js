const seatsEl = document.querySelector("#seats");
const homeEl = document.querySelector("#plan-home");
const referenceEl = document.querySelector("#plan-reference");
const HOME_LABELS = { repo: "Repository (docs/plans/)", linear: "Linear", notion: "Notion", ref: "Ref" };
const statusEl = document.querySelector("#status");
const sourceEl = document.querySelector("#source");
let roles = [];
let launchers = [];
let planHomes = [];
let seats = {};

const escape = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function status(text, kind = "") { statusEl.textContent = text; statusEl.className = kind; }

function load(data) {
  roles = data.roles || roles;
  launchers = data.launchers || launchers;
  const raw = data.raw || { seats: {} };
  seats = Object.fromEntries(roles.map((role) => [role, (raw.seats?.[role]?.models || []).map((model) => ({ id: model.id || "", launch: model.launch || launchers[0], cliModel: model.cliModel || "" }))]));
  planHomes = data.planHomes || planHomes;
  homeEl.innerHTML = planHomes.map((home) => `<option value="${escape(home)}">${escape(HOME_LABELS[home] || home)}</option>`).join("");
  homeEl.value = raw.plans?.home || "repo";
  referenceEl.value = raw.plans?.reference || "";
  syncReference();
  sourceEl.textContent = data.exists ? `Editing ${data.path}` : `No config at ${data.path} yet. These are the shipped defaults; Save creates the file.`;
  render();
  if (data.error) status(`The file on disk has a problem: ${data.error}`, "warn");
}

// A repository plan has no reference: it always goes in docs/plans/.
function syncReference() {
  const repo = homeEl.value === "repo";
  referenceEl.disabled = repo;
  if (repo) referenceEl.value = "";
}
homeEl.addEventListener("change", syncReference);

function render() {
  seatsEl.innerHTML = roles.map((role) => `
    <h3>${escape(role)}</h3>
    <table>
      <thead><tr><th></th><th>Model id</th><th>Launch</th><th>CLI model (optional)</th><th></th></tr></thead>
      <tbody>${seats[role].map((model, index) => `
        <tr data-role="${escape(role)}" data-index="${index}">
          <td class="quiet">${index === 0 ? "default" : "fallback"}</td>
          <td><input data-field="id" value="${escape(model.id)}" placeholder="e.g. claude-opus-5-5" aria-label="Model id"></td>
          <td><select data-field="launch" aria-label="Launch">${launchers.map((launch) => `<option ${launch === model.launch ? "selected" : ""}>${escape(launch)}</option>`).join("")}</select></td>
          <td><input data-field="cliModel" value="${escape(model.cliModel)}" placeholder="same as id" aria-label="CLI model"></td>
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
  seats[row.dataset.role][Number(row.dataset.index)][event.target.dataset.field] = event.target.value;
});

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
  if (homeEl.value !== "repo") raw.plans = referenceEl.value.trim() ? { home: homeEl.value, reference: referenceEl.value.trim() } : { home: homeEl.value };
  return raw;
}

async function save() {
  status("Saving…");
  const response = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft()) });
  const data = await response.json();
  if (!response.ok) { status(`Not saved: ${data.error}`, "warn"); return statusEl.scrollIntoView({ block: "nearest" }); }
  load({ ...data, roles, launchers, planHomes });
  status("Saved. New review briefs use these models; recorded reviews keep theirs.", "good");
  statusEl.scrollIntoView({ block: "nearest" });
}
for (const button of document.querySelectorAll(".save")) button.addEventListener("click", save);

const response = await fetch("/api/config");
const data = await response.json();
if (!response.ok) status(data.error, "warn"); else load(data);

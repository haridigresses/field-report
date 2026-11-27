import { configSource, normalizeId, REVIEW_ROLES, seatFor } from "./seats.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORE_KEYS = ["mergeReadiness", "structuralRisk", "implementationQuality", "evidenceConfidence", "outcomeConfidence"];
const SIGNAL_VALUES = {
  necessity: ["necessary", "questionable_roi"],
  scopeDrift: ["none", "minor", "material"],
  contractIntegrity: ["sound", "mixed", "broken"],
  evidenceQuality: ["strong", "mixed", "weak"]
};

export const CRR_ROLE = "crr";
export { REVIEW_ROLES };

function assertScore(value, key) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${key} must be an integer from 0 to 100`);
}

const isScore = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

function hasScores(input) {
  return SCORE_KEYS.every((key) => isScore(input.scores?.[key]) && String(input.scoreRationale?.[key] || "").trim());
}

// A seat review counts only when its model is on the valid list its brief
// pinned. Later config edits change new briefs, never recorded reviews.
export function seatModelsFor(item) {
  return Array.isArray(item?.seatModels) ? item.seatModels : null;
}

export function fitsSeat(model, brief) {
  const id = normalizeId(model);
  return Boolean(id && seatModelsFor(brief)?.includes(id));
}

export function reviewModelLabel(model) {
  return normalizeId(model) || String(model || "unknown");
}

export function reviewKind(kind) {
  if (kind === "crr" || kind === "mrr") return kind;
  return null;
}

export function isDurableReview(review) {
  return review?.legacy !== true && reviewKind(review?.kind) === "mrr";
}

export function isPersonaReview(review) {
  return isDurableReview(review) && REVIEW_ROLES.includes(review.role);
}

export function identityKey(projectId, role) {
  if (!["coordinator", "owner"].includes(role)) throw new Error("Identity role must be coordinator or owner");
  const project = String(projectId || "").trim().toLowerCase();
  if (!project) throw new Error("Identity requires a project ID");
  return { key: `${project}/${role}`, fallback: `${project}/${role}-2` };
}

export function seatingFor(role, model = null, route = null) {
  if (role === CRR_ROLE) {
    const selected = String(model || "local").trim();
    if (!selected) throw new Error("crr requires a model id");
    return { role: CRR_ROLE, intended: "local", model: selected, route: route || "native" };
  }
  const seatModels = seatFor(role).models.map((entry) => entry.id);
  const selected = model ? normalizeId(model) : seatModels[0];
  if (!seatModels.includes(selected)) throw new Error(`${model} is not a valid ${role} model (valid: ${seatModels.join(", ")}). Add it to seats.${role}.models in ${configSource()} to use it.`);
  return { role, intended: seatModels[0], seatModels, model: selected, route: route || "cli" };
}

function sameDeliveryUnit(item, { claim, claimRevision }) {
  return item.claim === claim && (item.claimRevision ?? 1) === (claimRevision ?? 1);
}

export function validateReview(input, delegation) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review envelope must be an object");
  if (input.reviewComplete !== true || input.independent !== true) throw new Error("Review requires reviewComplete=true and independent=true");
  if (!["GO", "NO_GO"].includes(input.verdict)) throw new Error("Review verdict must be GO or NO_GO");
  const kind = reviewKind(input.kind);
  const role = input.role;
  if (!kind) throw new Error("Review kind must be crr or mrr");
  if (kind === "crr" && role !== CRR_ROLE) throw new Error("CRR must use role crr");
  if (kind === "mrr" && (!REVIEW_ROLES.includes(role) || role !== delegation?.role)) throw new Error("MRR must identify its exact review role");
  if (kind === "crr" && role !== delegation?.role) throw new Error("Review must identify its exact review role");
  if (!UUID.test(input.delegationId || "") || input.delegationId !== delegation?.id) throw new Error("Review must reference its exact Field Report delegation ID");
  if (!String(input.claim || "").trim() || input.claim !== delegation?.claim) throw new Error("Review claim must match its exact Field Report delegation");
  if (!String(input.reviewerTaskId || "").trim()) throw new Error("Review requires a reviewer task or provider-run ID");
  if (!SHA.test(input.head || "") || !SHA.test(input.baseHead || "")) throw new Error("Review requires exact head and baseHead SHAs");
  if (kind === "crr" && !SHA.test(input.tree || "")) throw new Error("CRR requires the exact staged tree SHA");
  if (kind === "mrr" && input.tree != null) throw new Error("MRR must not include a staged tree");
  if (reviewKind(delegation.kind) !== kind || delegation.role !== role || delegation.head !== input.head || delegation.baseHead !== input.baseHead || (kind === "crr" && delegation.tree !== input.tree)) throw new Error("Review target does not match its delegation");
  let seatModels = null;
  if (kind === "crr") {
    if (!String(input.model || "").trim()) throw new Error("Review requires a model id");
    if (delegation.model && String(delegation.model) !== String(input.model)) throw new Error("Review model must match its exact delegation");
  } else {
    const model = normalizeId(input.model);
    if (!model) throw new Error("Review requires a model id");
    if (delegation.model && normalizeId(delegation.model) !== model) throw new Error("Review model must match its exact delegation");
    if (!fitsSeat(model, delegation)) throw new Error(`${role} review model ${model} is not on its brief's valid list`);
    seatModels = [...seatModelsFor(delegation)];
    input = { ...input, model };
  }
  if (!["native", "cli"].includes(input.route) || input.route !== delegation?.route) throw new Error("Review route must match its exact delegation");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (input.unresolved != null && (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review unresolved must be a nonblank string array");
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved : [];
  if (input.questions != null && (!Array.isArray(input.questions) || !input.questions.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review questions must be a nonblank string array");
  if (input.verdict === "NO_GO" && !(input.findings.length || unresolved.length)) throw new Error("NO_GO requires at least one finding or unresolved item");
  if (input.verdict === "GO" && (input.findings.length || unresolved.length)) throw new Error("GO cannot carry findings or unresolved items");
  if (!String(input.summary || "").trim()) throw new Error("Review requires a summary");
  for (const key of SCORE_KEYS) assertScore(input.scores?.[key], key);
  for (const key of SCORE_KEYS) if (!String(input.scoreRationale?.[key] || "").trim()) throw new Error(`${key} requires explanatory rationale`);
  if (kind === "mrr") {
    for (const [key, values] of Object.entries(SIGNAL_VALUES)) if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(", ")}`);
    if (!String(input.simplerPath || "").trim()) throw new Error("simplerPath must explain alternatives considered and discarded, or state that none were found");
  }
  const { legacy: _legacy, provider: _provider, seatModels: _seatModels, reconciled: _reconciled, ...rest } = input;
  return {
    ...rest,
    kind,
    role,
    unresolved,
    findings: [...input.findings],
    scores: { ...input.scores },
    ...(input.questions?.length ? { questions: [...input.questions] } : {}),
    ...(seatModels ? { seatModels } : {})
  };
}

// F-ids are display handles, numbered in record order across the workstream's
// MRR reviews. The store assigns the same numbers when it records a review.
export function findingLedger(reviews) {
  const entries = [];
  let counter = 0;
  for (const review of reviews) {
    if (!isDurableReview(review)) continue;
    for (const [category, items] of [["finding", review.findings], ["unresolved", review.unresolved]]) {
      for (const text of items || []) {
        counter += 1;
        entries.push({ id: `F${counter}`, category, text, role: review.role, head: review.head, delegationId: review.delegationId });
      }
    }
  }
  return entries;
}

const acceptedCrr = (review) => reviewKind(review?.kind) === "crr" && review?.role === CRR_ROLE && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasScores(review) && !(review.findings || []).length && !(review.unresolved || []).length;

function latestFor(reviews, predicate) { return [...reviews].reverse().find(predicate) || null; }

const short = (sha) => String(sha || "").slice(0, 12);

// A seat is decided by its reviewed commit nearest HEAD among HEAD and HEAD's
// ancestors (ancestors maps head to commits behind HEAD), whatever order the
// reviews were recorded in. On that head, any NO_GO finding the user has not accepted blocks,
// and a later review of the same head cannot clear it; a fix on a new head and
// a rerun of this seat can. A review of an earlier head carries forward, and
// the gate prints the delta this seat has not seen.
export function seatStatus(reviews, role, { target, claim, claimRevision, ancestors = null, dispositions = [], ledger = findingLedger(reviews) }) {
  const heads = ancestors || new Map([[target.head, 0]]);
  const mine = (reviews || []).filter((review) => isPersonaReview(review) && review.role === role && sameDeliveryUnit(review, { claim, claimRevision }) && heads.has(review.head));
  if (!mine.length) return { role, state: "missing", open: [], accepted: [] };
  const head = mine.reduce((best, review) => (heads.get(review.head) < heads.get(best) ? review.head : best), mine[0].head);
  const onHead = mine.filter((review) => review.head === head);
  const acceptance = new Map(dispositions.map((item) => [item.findingId, item]));
  const open = [];
  const accepted = [];
  for (const review of onHead.filter((item) => item.verdict === "NO_GO")) {
    for (const finding of ledger.filter((item) => item.delegationId === review.delegationId)) {
      if (acceptance.has(finding.id)) accepted.push({ ...finding, disposition: acceptance.get(finding.id) });
      else open.push(finding);
    }
  }
  return { role, state: open.length ? "blocked" : "satisfied", head, carried: head !== target.head, review: onHead[onHead.length - 1], open, accepted };
}

// One review per seat per exact head: a second look at the same code would
// only be shopping for a GO.
export function assertSeatOpen(reviews, { role, target, claim, claimRevision }) {
  const done = (reviews || []).find((review) => isPersonaReview(review) && review.role === role && review.head === target.head && sameDeliveryUnit(review, { claim, claimRevision }));
  if (!done) return;
  const accept = done.verdict === "NO_GO" ? ", or record the user's acceptance of its findings with fr review accept" : "";
  throw new Error(`${role} already reviewed this head (${done.verdict}); fix on a new head to rerun it${accept}`);
}

function evaluateCrrGate({ target, workstream, reviews }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = reviews.filter((review) => reviewKind(review.kind) === "crr" && review.role === CRR_ROLE && review.legacy !== true && review.claim === claim && (review.claimRevision ?? 1) === claimRevision && review.head === target.head && review.baseHead === target.baseHead && review.tree === target.tree);
  const latest = latestFor(matching, () => true);
  const reasons = [];
  if (!latest || !acceptedCrr(latest)) reasons.push(latest ? "crr is not a finding-free GO" : "missing crr");
  if (latest && workstream.ownerTaskId && latest.reviewerTaskId === workstream.ownerTaskId) reasons.push("Workstream owner cannot satisfy an independent review");
  if (latest?.ownerTaskIdAtBrief && latest.ownerTaskIdAtBrief === latest.reviewerTaskId) reasons.push("crr reviewer was the workstream owner when its review brief was created");
  return { ready: reasons.length === 0, kind: "crr", target, reasons, notes: [], lanes: { [CRR_ROLE]: latest } };
}

function evaluateMrrGate({ target, workstream, reviews, dispositions = [], ancestors = null }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const ledger = findingLedger(reviews);
  const seats = Object.fromEntries(REVIEW_ROLES.map((role) => [role, seatStatus(reviews, role, { target, claim, claimRevision, ancestors, dispositions, ledger })]));
  const reasons = [];
  const notes = [];
  for (const seat of Object.values(seats)) {
    const open = seat.open.map((finding) => `${finding.id}: ${finding.text}`).join(" | ");
    if (seat.state === "missing") reasons.push(`missing ${seat.role} review`);
    else if (seat.state === "blocked" && seat.carried) reasons.push(`${seat.role} NO_GO at ${short(seat.head)}; rerun this seat after the fix: ${open}`);
    else if (seat.state === "blocked") reasons.push(`${seat.role} NO_GO on this head; fix on a new head and rerun this seat, or record the user's acceptance (fr review accept): ${open}`);
    else {
      if (seat.carried) notes.push(`${seat.role}: ${seat.review.verdict} at ${short(seat.head)} carried; ${short(seat.head)}..${short(target.head)} not reviewed by this seat`);
      for (const finding of seat.accepted) notes.push(`${seat.role} ${finding.id} accepted by ${finding.disposition.actor}: ${finding.disposition.reason}`);
    }
    // Unsettled product questions never block, but READY must not hide them.
    for (const question of seat.review?.questions || []) notes.push(`${seat.role} asks the user: ${question}`);
  }
  const satisfied = Object.values(seats).filter((seat) => seat.state === "satisfied").map((seat) => seat.review);
  const reviewerIds = satisfied.map((review) => review.reviewerTaskId).filter(Boolean);
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("Review lanes require distinct reviewer task IDs");
  if (workstream.ownerTaskId && reviewerIds.includes(workstream.ownerTaskId)) reasons.push("Workstream owner cannot satisfy an independent review");
  for (const review of satisfied) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push(`${review.role} reviewer was the workstream owner when its review brief was created`);
  }
  const lanes = Object.fromEntries(REVIEW_ROLES.map((role) => [role, seats[role].review || null]));
  return { ready: reasons.length === 0, kind: "mrr", target, reasons, notes, lanes, seats };
}

export function latestClaimReviews(reviews, workstream) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = (reviews || []).filter((review) => review?.legacy !== true && [CRR_ROLE, ...REVIEW_ROLES].includes(review.role) && review.claim === claim && (review.claimRevision ?? 1) === claimRevision);
  return Object.fromEntries([CRR_ROLE, ...REVIEW_ROLES].map((role) => [role, latestFor(matching, (review) => review.role === role)]));
}

export function evaluateGate({ kind, target, workstream, reviews, dispositions = [], ancestors = null }) {
  const expected = reviewKind(kind);
  if (expected === "crr") return evaluateCrrGate({ target, workstream, reviews });
  if (expected === "mrr") return evaluateMrrGate({ target, workstream, reviews, dispositions, ancestors });
  throw new Error("Gate kind must be crr or mrr");
}

export function openReasons({ checkout, target } = {}) {
  const reasons = [];
  if (checkout?.dirty) reasons.push("checkout has uncommitted changes");
  if (target?.head && checkout?.head !== target.head) {
    reasons.push(`checkout HEAD ${(checkout.head || "unknown").slice(0, 12)} does not match reviewed head ${target.head.slice(0, 12)}`);
  }
  return reasons;
}

export const NO_GITHUB_CHECKS_REASON = "No GitHub checks observed; this is not evidence that CI ran";

export function botsReasons({ project, target, checkout, pr }) {
  const reasons = openReasons({ checkout, target });
  if (!pr) {
    reasons.push("no open pull request");
    return reasons;
  }
  if (pr.state !== "OPEN") reasons.push(`PR #${pr.number} is not open`);
  if (pr.headRefOid !== target.head) reasons.push("PR head does not match the reviewed exact head");
  if (pr.headRefName !== target.branch) reasons.push(`PR head branch ${pr.headRefName} does not match reviewed branch ${target.branch}`);
  if (pr.baseRefName !== project.baseBranch) reasons.push(`PR base ${pr.baseRefName} does not match configured base ${project.baseBranch}`);
  const accepted = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const checks = pr.statusCheckRollup || [];
  if (!checks.length) reasons.push(NO_GITHUB_CHECKS_REASON);
  if (checks.some((check) => check.conclusion && !accepted.has(check.conclusion))) reasons.push("GitHub checks include an unsuccessful conclusion");
  if (checks.some((check) => !check.conclusion && !accepted.has(check.state))) reasons.push("GitHub checks are incomplete or unsuccessful");
  return reasons;
}

export function workstreamBotsReasons({ workstream, workstreams, pr }) {
  const reasons = [];
  if (!pr) return reasons;
  const duplicateOwners = workstreams.filter((other) => other.id !== workstream.id && other.project === workstream.project && other.pullRequests.includes(pr.number));
  if (duplicateOwners.length) reasons.push(`PR #${pr.number} is also claimed by workstream${duplicateOwners.length === 1 ? "" : "s"} ${duplicateOwners.map((other) => other.id).join(", ")}`);
  return reasons;
}

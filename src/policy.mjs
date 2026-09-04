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
export const COURT_ROLE = "reconciliation";
export const REVIEW_ROLES = ["deep-code-review", "structural-challenge", "fable-challenge"];
export const REVIEW_MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  grok: "grok-4.6",
  fable: "claude-fable-5"
});
export const INTENDED_MODELS = Object.freeze({
  "deep-code-review": REVIEW_MODELS.sol,
  "structural-challenge": REVIEW_MODELS.grok,
  "fable-challenge": REVIEW_MODELS.fable
});

function assertScore(value, key) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${key} must be an integer from 0 to 100`);
}

const isScore = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

function hasScores(input) {
  return SCORE_KEYS.every((key) => isScore(input.scores?.[key]) && String(input.scoreRationale?.[key] || "").trim());
}

function hasMrrSignals(input) {
  return Object.entries(SIGNAL_VALUES).every(([key, values]) => values.includes(input[key]))
    && Boolean(String(input.simplerPath || "").trim());
}

const GROK_MODEL = /^(?:cursor-)?grok-4\.6(?:-(?:high|low|medium|xhigh))?(?:-fast)?$/;

export function canonicalReviewModel(model) {
  const text = String(model || "").trim();
  const lower = text.toLowerCase();
  if (lower === "gpt-5.6-sol") return REVIEW_MODELS.sol;
  if (lower === "claude-fable-5") return REVIEW_MODELS.fable;
  if (GROK_MODEL.test(lower)) return REVIEW_MODELS.grok;
  return null;
}

export function reviewModelLabel(model) {
  const canonical = canonicalReviewModel(model);
  if (canonical === REVIEW_MODELS.sol) return "Sol";
  if (canonical === REVIEW_MODELS.grok) return "Grok";
  if (canonical === REVIEW_MODELS.fable) return "Fable";
  return String(model || "unknown");
}

function providersFor(canonical) {
  if (canonical === REVIEW_MODELS.sol) return ["openai"];
  if (canonical === REVIEW_MODELS.fable) return ["anthropic"];
  if (canonical === REVIEW_MODELS.grok) return ["cursor", "xai"];
  return [];
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

export function isCourtReview(review) {
  return isDurableReview(review) && review.role === COURT_ROLE;
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
    return { role: CRR_ROLE, intended: "local", model: selected, substituted: false, route: route || "native" };
  }
  if (role === COURT_ROLE) {
    const selected = canonicalReviewModel(model);
    if (!selected) throw new Error("Court requires --model gpt-5.6-sol, grok-4.6, or claude-fable-5");
    return { role: COURT_ROLE, intended: null, model: selected, substituted: false, route: route || "cli" };
  }
  if (!REVIEW_ROLES.includes(role)) throw new Error("Unknown review role");
  const intended = INTENDED_MODELS[role];
  const selected = model ? canonicalReviewModel(model) : intended;
  if (!selected) throw new Error(`Unknown review model: ${model}`);
  return {
    role,
    intended,
    model: selected,
    substituted: selected !== intended,
    route: route || "cli"
  };
}

function sameReviewTarget(item, kind, target) {
  const expected = reviewKind(kind);
  return reviewKind(item.kind) === expected && item.head === target.head && item.baseHead === target.baseHead && (expected !== "crr" || item.tree === target.tree);
}

function sameDeliveryUnit(item, { claim, claimRevision }) {
  return item.claim === claim && (item.claimRevision ?? 1) === (claimRevision ?? 1);
}

function jobScope(item, { role, target, claim, claimRevision }) {
  return item.role === role && sameReviewTarget(item, "mrr", target) && sameDeliveryUnit(item, { claim, claimRevision });
}

export function substitutionReasonOf(item) {
  return String(item?.substitutionReason || "").trim();
}

export function validateReview(input, delegation) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review envelope must be an object");
  if (input.reviewComplete !== true || input.independent !== true) throw new Error("Review requires reviewComplete=true and independent=true");
  if (!["GO", "NO_GO"].includes(input.verdict)) throw new Error("Review verdict must be GO or NO_GO");
  const kind = reviewKind(input.kind);
  const role = input.role;
  if (!kind) throw new Error("Review kind must be crr or mrr");
  if (kind === "crr" && role !== CRR_ROLE) throw new Error("CRR must use role crr");
  if (kind === "mrr" && role === COURT_ROLE) {
    if (delegation?.reconciliationOnly !== true || delegation?.role !== COURT_ROLE) throw new Error("Court must identify its exact reconciliation brief");
  } else if (kind === "mrr" && (!REVIEW_ROLES.includes(role) || role !== delegation?.role)) throw new Error("MRR must identify its exact review role");
  if (kind === "crr" && role !== delegation?.role) throw new Error("Review must identify its exact review role");
  if (!UUID.test(input.delegationId || "") || input.delegationId !== delegation?.id) throw new Error("Review must reference its exact Field Report delegation ID");
  if (!String(input.claim || "").trim() || input.claim !== delegation?.claim) throw new Error("Review claim must match its exact Field Report delegation");
  if (!String(input.reviewerTaskId || "").trim()) throw new Error("Review requires a reviewer task or provider-run ID");
  if (!SHA.test(input.head || "") || !SHA.test(input.baseHead || "")) throw new Error("Review requires exact head and baseHead SHAs");
  if (kind === "crr" && !SHA.test(input.tree || "")) throw new Error("CRR requires the exact staged tree SHA");
  if (kind === "mrr" && input.tree != null) throw new Error("MRR must not include a staged tree");
  if (reviewKind(delegation.kind) !== kind || delegation.role !== role || delegation.head !== input.head || delegation.baseHead !== input.baseHead || (kind === "crr" && delegation.tree !== input.tree)) throw new Error("Review target does not match its delegation");
  let substitutionReason = "";
  if (kind === "crr") {
    if (!String(input.model || "").trim()) throw new Error("Review requires a model id");
    if (delegation.model && String(delegation.model) !== String(input.model)) throw new Error("Review model must match its exact delegation");
    if (!String(input.provider || "").trim()) throw new Error("Review requires a provider");
  } else {
    const model = canonicalReviewModel(input.model);
    if (!model) throw new Error("Review model must be gpt-5.6-sol, grok-4.6, or claude-fable-5");
    if (delegation.model && canonicalReviewModel(delegation.model) !== model) throw new Error("Review model must match its exact delegation");
    if (!providersFor(model).includes(input.provider)) throw new Error(`Provider does not match review model ${model}`);
    if (role !== COURT_ROLE) {
      const intended = INTENDED_MODELS[role];
      substitutionReason = substitutionReasonOf(delegation);
      if (substitutionReasonOf(input) && substitutionReasonOf(input) !== substitutionReason) {
        throw new Error("substitutionReason must match its exact delegation");
      }
      if (model !== intended && !substitutionReason) throw new Error(`${role} substitution requires a non-empty substitutionReason; intended model is ${intended}`);
      if (model === intended && substitutionReason) throw new Error("substitutionReason is only valid when the intended model was not used");
    }
    input = { ...input, model };
  }
  if (!["native", "cli"].includes(input.route) || input.route !== delegation?.route) throw new Error("Review route must match its exact delegation");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (input.unresolved != null && (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review unresolved must be a nonblank string array");
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved : [];
  if (role === COURT_ROLE) {
    if (input.findings.length) throw new Error("Court cannot add findings");
    if (unresolved.length) throw new Error("Court cannot add unresolved items");
  }
  if (input.verdict === "NO_GO" && !noGoHasEvidence({ ...input, unresolved })) throw new Error("NO_GO requires at least one finding, unresolved item, or still_present reconciliation");
  if (!String(input.summary || "").trim()) throw new Error("Review requires a summary");
  for (const key of SCORE_KEYS) assertScore(input.scores?.[key], key);
  for (const key of SCORE_KEYS) if (!String(input.scoreRationale?.[key] || "").trim()) throw new Error(`${key} requires explanatory rationale`);
  if (kind === "mrr") {
    for (const [key, values] of Object.entries(SIGNAL_VALUES)) if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(", ")}`);
    if (!String(input.simplerPath || "").trim()) throw new Error("simplerPath must explain alternatives considered and discarded, or state that none were found");
  }
  if (input.reconciled != null) {
    if (kind !== "mrr") throw new Error("CRR does not reconcile durable findings");
    if (!Array.isArray(input.reconciled)) throw new Error("reconciled must be an array of finding reconciliations");
    for (const entry of input.reconciled) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each reconciled entry must be an object");
      const allowed = role === COURT_ROLE ? ["rejected", "still_present"] : ["resolved", "rejected", "still_present"];
      if (!String(entry.findingId || "").trim() || !allowed.includes(entry.disposition) || !String(entry.rationale || "").trim()) {
        throw new Error(role === COURT_ROLE
          ? "Each court entry requires findingId, disposition rejected|still_present, and evidence-based rationale"
          : "Each reconciled entry requires findingId, disposition resolved|rejected|still_present, and evidence-based rationale");
      }
    }
    const ids = input.reconciled.map((entry) => entry.findingId);
    if (new Set(ids).size !== ids.length) throw new Error("reconciled entries must reference distinct finding IDs");
  } else if (role === COURT_ROLE) {
    throw new Error("Court must adjudicate the delivered packet");
  }
  const { reconciliationOnly: _reconciliationOnly, jobRole: _jobRole, legacy: _legacy, staleAtRecord: _staleAtRecord, ...rest } = input;
  return {
    ...rest,
    kind,
    role,
    unresolved,
    findings: [...input.findings],
    scores: { ...input.scores },
    ...(substitutionReason ? { substitutionReason } : {}),
    ...(input.reconciled ? { reconciled: input.reconciled.map((entry) => ({ ...entry })) } : {}),
    ...(role === COURT_ROLE ? { reconciliationOnly: true, jobRole: delegation.jobRole } : {})
  };
}

export function findingLedger(reviews) {
  const entries = [];
  let counter = 0;
  for (const review of reviews) {
    if (!isDurableReview(review) || isCourtReview(review)) continue;
    for (const [category, items] of [["finding", review.findings], ["unresolved", review.unresolved]]) {
      for (const text of items || []) {
        counter += 1;
        entries.push({
          id: `F${counter}`,
          category,
          text,
          role: review.role,
          claim: review.claim,
          claimRevision: review.claimRevision ?? 1,
          head: review.head,
          baseHead: review.baseHead,
          delegationId: review.delegationId,
          reviewerTaskId: review.reviewerTaskId,
          model: review.model
        });
      }
    }
  }
  return entries;
}

function deliveryScopeKey(claim, claimRevision, head, baseHead) {
  return JSON.stringify([claim, claimRevision ?? 1, head || "", baseHead || ""]);
}

export function outstandingFindings(reviews, claim, target, claimRevision = 1) {
  const state = new Map();
  for (const review of reviews) {
    if (!isDurableReview(review)) continue;
    if (review.staleAtRecord === true) continue;
    for (const entry of review.reconciled || []) {
      const current = state.get(entry.findingId) || { resolved: false, rejectedScopes: new Set() };
      const key = deliveryScopeKey(review.claim, review.claimRevision, review.head, review.baseHead);
      if (entry.disposition === "resolved") current.resolved = true;
      else if (entry.disposition === "rejected") current.rejectedScopes.add(key);
      else {
        current.resolved = false;
        current.rejectedScopes.delete(key);
      }
      state.set(entry.findingId, current);
    }
  }
  const queryKey = target ? deliveryScopeKey(claim, claimRevision, target.head, target.baseHead) : null;
  return findingLedger(reviews).filter((finding) => {
    const current = state.get(finding.id);
    if (current?.resolved) return false;
    if (!current?.rejectedScopes.size) return true;
    if (queryKey) return !current.rejectedScopes.has(queryKey);
    for (const key of current.rejectedScopes) {
      if (JSON.parse(key)[0] === claim) return false;
    }
    return true;
  });
}

export function outstandingForDeep(reviews, claim, target, claimRevision = 1) {
  return outstandingFindings(reviews, claim, target, claimRevision).filter((finding) => {
    const sameTarget = Boolean(finding.head) && sameReviewTarget({ kind: "mrr", head: finding.head, baseHead: finding.baseHead }, "mrr", target);
    const sameUnit = (finding.claimRevision ?? 1) === claimRevision;
    return !sameTarget || !sameUnit;
  });
}

export function occupantPacket(reviews, occupant) {
  if (!occupant) return [];
  const ledger = findingLedger(reviews);
  const minted = ledger.filter((finding) => finding.delegationId === occupant.delegationId);
  const ids = new Set(minted.map((finding) => finding.id));
  for (const entry of occupant.reconciled || []) {
    if (entry.disposition !== "still_present") continue;
    const finding = ledger.find((item) => item.id === entry.findingId);
    if (finding && !ids.has(finding.id)) {
      minted.push(finding);
      ids.add(finding.id);
    }
  }
  return minted;
}

export function outstandingOccupantPacket(reviews, occupant, claim) {
  const outstanding = new Set(outstandingFindings(reviews, claim, occupant, occupant.claimRevision ?? 1).map((finding) => finding.id));
  return occupantPacket(reviews, occupant).filter((finding) => outstanding.has(finding.id));
}

const acceptedMrr = (review, delegations = []) => {
  if (!(isPersonaReview(review) && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasScores(review) && hasMrrSignals(review) && !(review.findings || []).length && !(review.unresolved || []).length)) return false;
  const intended = INTENDED_MODELS[review.role];
  const model = canonicalReviewModel(review.model);
  if (model === intended) return true;
  const delegation = (delegations || []).find((item) => item.id === review.delegationId);
  return Boolean(substitutionReasonOf(delegation || (delegations.length ? null : review)));
};
const acceptedCrr = (review) => reviewKind(review?.kind) === "crr" && review?.role === CRR_ROLE && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasScores(review) && !(review.findings || []).length && !(review.unresolved || []).length;

function latestFor(reviews, predicate) { return [...reviews].reverse().find(predicate) || null; }

export function personaJobReviews(reviews, { role, target, claim, claimRevision }) {
  return (reviews || []).filter((review) => isPersonaReview(review) && review.staleAtRecord !== true && jobScope(review, { role, target, claim, claimRevision }));
}

export function jobCourts(reviews, { jobRole, target, claim, claimRevision }) {
  return (reviews || []).filter((review) => isCourtReview(review) && review.staleAtRecord !== true && (review.jobRole || null) === jobRole && sameReviewTarget(review, "mrr", target) && sameDeliveryUnit(review, { claim, claimRevision }));
}

export function participatingPersonaReviews(reviews, { target, claim, claimRevision }) {
  return REVIEW_ROLES.flatMap((role) => personaJobReviews(reviews, { role, target, claim, claimRevision }));
}

export function courtReviewsOnTarget(reviews, { target, claim, claimRevision }) {
  return REVIEW_ROLES.flatMap((jobRole) => jobCourts(reviews, { jobRole, target, claim, claimRevision }));
}

export function courtFullyRejected(reviews, occupant, { target, claim, claimRevision }) {
  const ids = occupantPacket(reviews, occupant).map((finding) => finding.id);
  if (!ids.length) return false;
  const latest = new Map();
  for (const court of jobCourts(reviews, { jobRole: occupant.role, target, claim, claimRevision })) {
    for (const entry of court.reconciled || []) {
      if (ids.includes(entry.findingId)) latest.set(entry.findingId, entry.disposition);
    }
  }
  return ids.every((id) => latest.get(id) === "rejected");
}

function createdDelegation(delegations, delegationId) {
  return (delegations || []).find((item) => item.id === delegationId && item.event === "created") || null;
}

function isPostCourtRerun(review, first, { reviews, courtIndex, courts, delegations }) {
  if (canonicalReviewModel(review.model) !== canonicalReviewModel(first.model)) return false;
  if ((reviews || []).indexOf(review) <= courtIndex) return false;
  const created = createdDelegation(delegations, review.delegationId);
  const court = courts[courts.length - 1];
  if (!created?.createdAt || !court?.recordedAt) return true;
  return Date.parse(created.createdAt) > Date.parse(court.recordedAt);
}

export function occupyingReview(reviews, scope, delegations = []) {
  const persona = personaJobReviews(reviews, scope);
  if (!persona.length) return null;
  const first = persona[0];
  if (first.verdict !== "NO_GO" || !courtFullyRejected(reviews, first, scope)) return first;
  const courts = jobCourts(reviews, { jobRole: scope.role, target: scope.target, claim: scope.claim, claimRevision: scope.claimRevision });
  const courtIndex = Math.max(-1, ...courts.map((review) => (reviews || []).indexOf(review)));
  const rerun = persona.slice(1).find((review) => isPostCourtRerun(review, first, { reviews, courtIndex, courts, delegations }));
  return rerun || first;
}

export function substitutionLine(review, role = review?.role) {
  if (!review || !substitutionReasonOf(review)) return null;
  const intended = INTENDED_MODELS[role] || INTENDED_MODELS[review.role];
  return `${role}: ${review.verdict} via ${reviewModelLabel(review.model)}; intended ${reviewModelLabel(intended)} was substituted: ${substitutionReasonOf(review)}`;
}

export function assertPersonaJobAvailable(reviews, { role, target, claim, claimRevision, model, substitutionReason, reviewerTaskId, delegations = [], currentDelegation = null }) {
  const selected = canonicalReviewModel(model);
  if (!REVIEW_ROLES.includes(role)) throw new Error("Unknown review role");
  if (!selected) throw new Error(`Unknown review model: ${model}`);
  const scope = { role, target, claim, claimRevision };
  const occupant = occupyingReview(reviews, scope, delegations);
  const intended = INTENDED_MODELS[role];
  if (reviewerTaskId && courtReviewsOnTarget(reviews, { target, claim, claimRevision }).some((review) => review.reviewerTaskId === reviewerTaskId)) {
    throw new Error("A court reviewer cannot fill a persona job");
  }
  if (!occupant) {
    if (selected !== intended && !String(substitutionReason || "").trim()) {
      throw new Error(`${role} substitution requires a non-empty substitutionReason; intended model is ${intended}`);
    }
    return;
  }
  if (acceptedMrr(occupant) || occupant.verdict === "GO") {
    throw new Error(`${role} job is occupied by a completed envelope`);
  }
  const first = personaJobReviews(reviews, scope)[0];
  if (occupant !== first) throw new Error(`${role} authorized rerun occupied this job; fix on a new head`);
  const courts = jobCourts(reviews, { jobRole: role, target, claim, claimRevision });
  if (courts.length && courtFullyRejected(reviews, first, scope)) {
    if (canonicalReviewModel(first.model) !== selected) {
      throw new Error(`${role} court granted one rerun of ${reviewModelLabel(first.model)}; do not substitute another model`);
    }
    const court = courts[courts.length - 1];
    if (currentDelegation?.createdAt && court?.recordedAt && Date.parse(currentDelegation.createdAt) <= Date.parse(court.recordedAt)) {
      throw new Error(`${role} authorized rerun requires a brief created after the court`);
    }
    return;
  }
  if (courts.length) throw new Error(`${role} occupying packet already had its one court; fix on a new head`);
  throw new Error(`${role} job is occupied by ${reviewModelLabel(occupant.model)} ${occupant.verdict}; adjudicate that packet or fix on a new head`);
}

export function assertCourtJobAvailable(reviews, { jobRole, target, claim, claimRevision, model, reviewerTaskId, ownerTaskId }) {
  if (!REVIEW_ROLES.includes(jobRole)) throw new Error("Court requires the persona job being adjudicated");
  const selected = canonicalReviewModel(model);
  if (!selected) throw new Error("Court requires --model gpt-5.6-sol, grok-4.6, or claude-fable-5");
  const occupant = occupyingReview(reviews, { role: jobRole, target, claim, claimRevision });
  if (!occupant) throw new Error(`${jobRole} has no occupying envelope to adjudicate`);
  if (occupant.verdict !== "NO_GO") throw new Error(`${jobRole} is a finding-free GO; court does not apply`);
  if (!occupantPacket(reviews, occupant).length) throw new Error(`${jobRole} occupying NO_GO has no packet to adjudicate; fix on a new head`);
  const first = personaJobReviews(reviews, { role: jobRole, target, claim, claimRevision })[0];
  if (occupant !== first) throw new Error(`${jobRole} authorized rerun occupied this job; fix on a new head`);
  if (jobCourts(reviews, { jobRole, target, claim, claimRevision }).length) throw new Error(`${jobRole} occupying packet already had its one court`);
  if (canonicalReviewModel(occupant.model) === selected) throw new Error("Court cannot be the model that produced the occupying NO_GO");
  if (ownerTaskId && reviewerTaskId && ownerTaskId === reviewerTaskId) throw new Error("Workstream owner cannot adjudicate");
  if (reviewerTaskId && participatingPersonaReviews(reviews, { target, claim, claimRevision }).some((review) => review.reviewerTaskId === reviewerTaskId)) {
    throw new Error("A participating persona reviewer cannot adjudicate");
  }
}

const acceptedMrrOccupant = (review, delegations = []) => Boolean(review) && acceptedMrr(review, delegations);

function evaluateCrrGate({ target, workstream, reviews }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = reviews.filter((review) => reviewKind(review.kind) === "crr" && review.role === CRR_ROLE && review.legacy !== true && review.claim === claim && (review.claimRevision ?? 1) === claimRevision && review.head === target.head && review.baseHead === target.baseHead && review.tree === target.tree);
  const latest = latestFor(matching, () => true);
  const accepted = latest && acceptedCrr(latest) ? [latest] : [];
  const reasons = [];
  if (!accepted.length) reasons.push(latest && !acceptedCrr(latest) ? "crr is not a finding-free GO" : "missing crr");
  const reviewerIds = accepted.map((review) => review.reviewerTaskId).filter(Boolean);
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("CRR reviewers require distinct task IDs");
  if (workstream.ownerTaskId && reviewerIds.includes(workstream.ownerTaskId)) reasons.push("Workstream owner cannot satisfy an independent review");
  for (const review of accepted) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push("crr reviewer was the workstream owner when its review brief was created");
  }
  return { ready: reasons.length === 0, kind: "crr", target, reasons, notes: [], lanes: { [CRR_ROLE]: latestFor(matching, acceptedCrr) || latest } };
}

function evaluateMrrGate({ target, workstream, reviews, delegations = [] }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const scope = { target, claim, claimRevision };
  const lanes = Object.fromEntries(REVIEW_ROLES.map((role) => [role, occupyingReview(reviews, { role, ...scope }, delegations)]));
  const reasons = [];
  const notes = [];
  let acceptedCount = 0;
  for (const role of REVIEW_ROLES) {
    const review = lanes[role];
    if (review && acceptedMrrOccupant(review, delegations)) acceptedCount += 1;
    else if (review && !acceptedMrrOccupant(review, delegations)) reasons.push(`${role} is not a finding-free GO`);
    else reasons.push(`missing ${role} review`);
    const substitution = substitutionLine(review, role);
    if (substitution) notes.push(substitution);
  }
  const reviewerIds = REVIEW_ROLES.map((role) => lanes[role]?.reviewerTaskId).filter(Boolean);
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("Review lanes require distinct reviewer task IDs");
  const courtIds = new Set(courtReviewsOnTarget(reviews, scope).map((review) => review.reviewerTaskId).filter(Boolean));
  if (reviewerIds.some((id) => courtIds.has(id))) reasons.push("Persona reviewers cannot reuse a court reviewer task ID");
  if (workstream.ownerTaskId && (reviewerIds.includes(workstream.ownerTaskId) || courtIds.has(workstream.ownerTaskId))) {
    reasons.push("Workstream owner cannot satisfy an independent review");
  }
  for (const review of Object.values(lanes).filter(Boolean)) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push(`${review.role} reviewer was the workstream owner when its review brief was created`);
  }
  for (const review of courtReviewsOnTarget(reviews, scope)) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) {
      reasons.push("Court reviewer was the workstream owner when its review brief was created");
    }
  }
  for (const finding of outstandingFindings(reviews, claim, target, claimRevision)) reasons.push(`unreconciled ${finding.role} ${finding.category} ${finding.id}: ${finding.text}`);
  return { ready: reasons.length === 0 && acceptedCount === 3, kind: "mrr", target, reasons, notes, lanes };
}

export function latestClaimReviews(reviews, workstream) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = (reviews || []).filter((review) => review?.legacy !== true && !isCourtReview(review) && review.claim === claim && (review.claimRevision ?? 1) === claimRevision);
  return Object.fromEntries([CRR_ROLE, ...REVIEW_ROLES].map((role) => [role, latestFor(matching, (review) => review.role === role)]));
}

export function lastReadyMrr(reviews, workstream, delegations = []) {
  const seen = new Set();
  for (const review of [...(reviews || [])].reverse()) {
    if (!acceptedMrr(review, delegations)) continue;
    const key = `${review.head}:${review.baseHead}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gate = evaluateMrrGate({ target: { kind: "mrr", head: review.head, baseHead: review.baseHead }, workstream, reviews, delegations });
    if (gate.ready) return { head: review.head, baseHead: review.baseHead };
  }
  return null;
}

export function noGoHasEvidence(input) {
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved : [];
  return Boolean((input.findings || []).length || unresolved.length || (input.reconciled || []).some((entry) => entry.disposition === "still_present"));
}

export function matchingWaiver(waivers, { target, workstream }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  return [...(waivers || [])].reverse().find((item) => item.head === target.head && item.baseHead === target.baseHead && item.claim === claim && (item.claimRevision ?? 1) === claimRevision && String(item.actor || "").trim()) || null;
}

export function evaluateMergeReady({ target, workstream, reviews, delegations = [], waivers = [] }) {
  const exact = evaluateMrrGate({ target, workstream, reviews, delegations });
  if (exact.ready) return { ...exact, phase: "ready", via: "mrr" };
  const claim = workstream.claim ?? workstream.summary;
  const outstanding = outstandingFindings(reviews, claim, target, workstream.claimRevision ?? 1);
  const last = lastReadyMrr(reviews, workstream, delegations);
  const waiver = matchingWaiver(waivers, { target, workstream });
  if (waiver) {
    const reasons = [];
    if (!last) reasons.push("waiver requires a prior finding-free MRR on this claim");
    if (!String(waiver.actor || "").trim()) reasons.push("waiver requires a recorded actor");
    for (const finding of outstanding) reasons.push(`unreconciled ${finding.role} ${finding.category} ${finding.id}: ${finding.text}`);
    if (!reasons.length) return { ...exact, ready: true, reasons: [], phase: "waived", via: "waiver", waiver };
    return { ...exact, ready: false, reasons, phase: "blocked", via: "waiver-invalid", waiver };
  }
  if (last && last.head !== target.head) {
    return {
      ...exact,
      ready: false,
      phase: "churn",
      via: "churn",
      lastHead: last.head,
      reasons: [`last MRR at ${last.head.slice(0, 12)}; HEAD ${target.head.slice(0, 12)}; CRR until you ask for final MRR`]
    };
  }
  return { ...exact, phase: "blocked", via: "mrr" };
}

export function evaluateGate({ kind, target, workstream, reviews, delegations = [] }) {
  const expected = reviewKind(kind);
  if (expected === "crr") return evaluateCrrGate({ target, workstream, reviews, delegations });
  if (expected === "mrr") return evaluateMrrGate({ target, workstream, reviews, delegations });
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

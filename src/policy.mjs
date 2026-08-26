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
export const REVIEW_ROLES = ["deep-code-review", "structural-challenge", "fable-challenge"];
export const REVIEW_MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  grok: "grok-4.6",
  fable: "claude-fable-5"
});
export const LANE_SEATING = Object.freeze({
  "deep-code-review": { preferred: REVIEW_MODELS.sol, backup: REVIEW_MODELS.grok, preferredRoute: "cli", backupRoute: "cli" },
  "structural-challenge": { preferred: REVIEW_MODELS.grok, backup: REVIEW_MODELS.sol, preferredRoute: "cli", backupRoute: "cli" },
  "fable-challenge": { preferred: REVIEW_MODELS.fable, backup: REVIEW_MODELS.grok, preferredRoute: "cli", backupRoute: "cli" }
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
    return { role: CRR_ROLE, preferred: "local", backup: null, model: selected, route: route || "native" };
  }
  if (!REVIEW_ROLES.includes(role)) throw new Error("Unknown review role");
  const lane = LANE_SEATING[role];
  const selected = model ? canonicalReviewModel(model) : lane.preferred;
  if (!selected) throw new Error(`Unknown review model: ${model}`);
  if (selected !== lane.preferred && selected !== lane.backup) throw new Error(`${role} must use ${lane.preferred} or its named backup ${lane.backup}`);
  const usingBackup = selected !== lane.preferred;
  return {
    role,
    preferred: lane.preferred,
    backup: lane.backup,
    model: selected,
    route: route || (usingBackup ? lane.backupRoute : lane.preferredRoute)
  };
}

function sameReviewTarget(item, kind, target) {
  const expected = reviewKind(kind);
  return reviewKind(item.kind) === expected && item.head === target.head && item.baseHead === target.baseHead && (expected !== "crr" || item.tree === target.tree);
}

function sameDeliveryUnit(item, { claim, claimRevision }) {
  return item.claim === claim && (item.claimRevision ?? 1) === (claimRevision ?? 1);
}

function preferredCreated(item, { role, kind, target, claim, claimRevision }, preferred) {
  return item.event === "created" && item.type === "review" && item.role === role && canonicalReviewModel(item.model) === preferred && sameReviewTarget(item, kind, target) && sameDeliveryUnit(item, { claim, claimRevision });
}

export function preferredAttemptFailed(delegations, scope) {
  const preferred = LANE_SEATING[scope.role]?.preferred;
  if (!preferred) return false;
  const failed = new Set((delegations || []).filter((item) => item.event === "failed").map((item) => item.id));
  return (delegations || []).some((item) => preferredCreated(item, scope, preferred) && failed.has(item.id));
}

export function preferredAlreadyAttempted(delegations, scope, reviews = []) {
  const preferred = LANE_SEATING[scope.role]?.preferred;
  if (!preferred) return false;
  const used = new Set((delegations || []).filter((item) => item.event === "bound" || item.event === "failed" || item.event === "completed").map((item) => item.id));
  for (const review of reviews || []) if (review.delegationId) used.add(review.delegationId);
  return (delegations || []).some((item) => preferredCreated(item, scope, preferred) && used.has(item.id));
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
  if (kind === "crr") {
    if (!String(input.model || "").trim()) throw new Error("Review requires a model id");
    if (delegation.model && String(delegation.model) !== String(input.model)) throw new Error("Review model must match its exact delegation");
    if (!String(input.provider || "").trim()) throw new Error("Review requires a provider");
  } else {
    const model = canonicalReviewModel(input.model);
    if (!model) throw new Error("Review model must be gpt-5.6-sol, grok-4.6, or claude-fable-5");
    const lane = LANE_SEATING[role];
    if (model !== lane.preferred && model !== lane.backup) throw new Error(`${role} must use ${lane.preferred} or its named backup ${lane.backup}`);
    if (delegation.model && canonicalReviewModel(delegation.model) !== model) throw new Error("Review model must match its exact delegation");
    if (!providersFor(model).includes(input.provider)) throw new Error(`Provider does not match review model ${model}`);
    input = { ...input, model };
  }
  if (!["native", "cli"].includes(input.route) || input.route !== delegation?.route) throw new Error("Review route must match its exact delegation");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (input.unresolved != null && (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review unresolved must be a nonblank string array");
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved : [];
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
      if (!String(entry.findingId || "").trim() || !["resolved", "rejected", "still_present"].includes(entry.disposition) || !String(entry.rationale || "").trim()) throw new Error("Each reconciled entry requires findingId, disposition resolved|rejected|still_present, and evidence-based rationale");
    }
    const ids = input.reconciled.map((entry) => entry.findingId);
    if (new Set(ids).size !== ids.length) throw new Error("reconciled entries must reference distinct finding IDs");
  }
  return { ...input, kind, role, unresolved, findings: [...input.findings], scores: { ...input.scores }, ...(input.reconciled ? { reconciled: input.reconciled.map((entry) => ({ ...entry })) } : {}) };
}

export function findingLedger(reviews) {
  const entries = [];
  let counter = 0;
  for (const review of reviews) {
    if (!isDurableReview(review)) continue;
    for (const [category, items] of [["finding", review.findings], ["unresolved", review.unresolved]]) {
      for (const text of items || []) {
        counter += 1;
        entries.push({ id: `F${counter}`, category, text, role: review.role, claim: review.claim });
      }
    }
  }
  return entries;
}

export function outstandingFindings(reviews, claim) {
  const state = new Map();
  for (const review of reviews) {
    if (!isDurableReview(review)) continue;
    if (review.staleAtRecord === true) continue;
    for (const entry of review.reconciled || []) {
      const current = state.get(entry.findingId) || { resolved: false, rejectedClaims: new Set() };
      if (entry.disposition === "resolved") current.resolved = true;
      else if (entry.disposition === "rejected") current.rejectedClaims.add(review.claim);
      else {
        current.resolved = false;
        current.rejectedClaims.delete(review.claim);
      }
      state.set(entry.findingId, current);
    }
  }
  return findingLedger(reviews).filter((finding) => {
    const current = state.get(finding.id);
    return !current?.resolved && !current?.rejectedClaims.has(claim);
  });
}

const acceptedMrr = (review) => isDurableReview(review) && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasScores(review) && hasMrrSignals(review) && !(review.findings || []).length && !(review.unresolved || []).length;
const acceptedCrr = (review) => reviewKind(review?.kind) === "crr" && review?.role === CRR_ROLE && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasScores(review) && !(review.findings || []).length && !(review.unresolved || []).length;

function latestFor(reviews, predicate) { return [...reviews].reverse().find(predicate) || null; }

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
  return { ready: reasons.length === 0, kind: "crr", target, reasons, lanes: { [CRR_ROLE]: latestFor(matching, acceptedCrr) || latest } };
}

function evaluateMrrGate({ target, workstream, reviews, delegations = [] }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = reviews.filter((review) => isDurableReview(review) && review.claim === claim && (review.claimRevision ?? 1) === claimRevision && review.head === target.head && review.baseHead === target.baseHead);
  const lanes = Object.fromEntries(REVIEW_ROLES.map((role) => [role, latestFor(matching, (review) => review.role === role)]));
  const reasons = [];
  let acceptedCount = 0;
  let unavailable = 0;
  for (const role of REVIEW_ROLES) {
    const review = lanes[role];
    const backupWithoutFailure = review && acceptedMrr(review) && canonicalReviewModel(review.model) === LANE_SEATING[role].backup && LANE_SEATING[role].backup !== LANE_SEATING[role].preferred && !preferredAttemptFailed(delegations, { role, kind: "mrr", target, claim, claimRevision });
    if (review && acceptedMrr(review) && !backupWithoutFailure) acceptedCount += 1;
    else if (backupWithoutFailure) reasons.push(`${role} backup requires a terminal preferred-model failure`);
    else if (review && !acceptedMrr(review)) reasons.push(`${role} is not a finding-free GO`);
    else if (preferredAttemptFailed(delegations, { role, kind: "mrr", target, claim, claimRevision })) unavailable += 1;
    else reasons.push(`missing ${role} review`);
  }
  if (acceptedCount < 2 && unavailable > 0 && !reasons.length) reasons.push("Review requires two finding-free persona GOs");
  const reviewerIds = REVIEW_ROLES.map((role) => lanes[role]?.reviewerTaskId).filter(Boolean);
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("Review lanes require distinct reviewer task IDs");
  if (workstream.ownerTaskId && reviewerIds.includes(workstream.ownerTaskId)) reasons.push("Workstream owner cannot satisfy an independent review");
  for (const review of Object.values(lanes).filter(Boolean)) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push(`${review.role} reviewer was the workstream owner when its review brief was created`);
  }
  for (const finding of outstandingFindings(reviews, claim)) reasons.push(`unreconciled ${finding.role} ${finding.category} ${finding.id}: ${finding.text}`);
  return { ready: reasons.length === 0 && acceptedCount >= 2, kind: "mrr", target, reasons, lanes };
}

export function latestClaimReviews(reviews, workstream) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = (reviews || []).filter((review) => review?.legacy !== true && review.claim === claim && (review.claimRevision ?? 1) === claimRevision);
  return Object.fromEntries([CRR_ROLE, ...REVIEW_ROLES].map((role) => [role, latestFor(matching, (review) => review.role === role)]));
}

export function lastReadyMrr(reviews, workstream, delegations = []) {
  const seen = new Set();
  for (const review of [...(reviews || [])].reverse()) {
    if (!acceptedMrr(review)) continue;
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
  const outstanding = outstandingFindings(reviews, claim);
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

export function openReasons({ checkout }) {
  const reasons = [];
  if (checkout.dirty) reasons.push("checkout has uncommitted changes");
  return reasons;
}

export function botsReasons({ project, target, checkout, pr }) {
  const reasons = openReasons({ checkout });
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

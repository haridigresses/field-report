const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORE_KEYS = ["mergeReadiness", "structuralRisk", "implementationQuality", "evidenceConfidence", "outcomeConfidence"];
const SIGNAL_VALUES = {
  necessity: ["necessary", "questionable_roi"],
  scopeDrift: ["none", "minor", "material"],
  contractIntegrity: ["sound", "mixed", "broken"],
  evidenceQuality: ["strong", "mixed", "weak"]
};
export const REVIEWER_FAMILIES = ["codex", "cursor", "claude"];
export const REVIEW_ROLE = "comprehensive-review";

function assertScore(value, key) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${key} must be an integer from 0 to 100`);
}

const isScore = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

function hasCompleteEvidence(input) {
  return SCORE_KEYS.every((key) => isScore(input.scores?.[key]) && String(input.scoreRationale?.[key] || "").trim())
    && Object.entries(SIGNAL_VALUES).every(([key, values]) => values.includes(input[key]))
    && Boolean(String(input.simplerPath || "").trim());
}

export function validateReview(input, delegation) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review envelope must be an object");
  if (input.reviewComplete !== true || input.independent !== true) throw new Error("Review requires reviewComplete=true and independent=true");
  if (!["GO", "NO_GO"].includes(input.verdict)) throw new Error("Review verdict must be GO or NO_GO");
  if (!["commit", "final"].includes(input.kind)) throw new Error("Review kind must be commit or final");
  if (input.role !== REVIEW_ROLE) throw new Error(`Review role must be ${REVIEW_ROLE}`);
  if (!REVIEWER_FAMILIES.includes(input.reviewerFamily) || input.reviewerFamily !== delegation?.reviewerFamily) throw new Error("Review must identify its exact reviewer family");
  if (!UUID.test(input.delegationId || "") || input.delegationId !== delegation?.id) throw new Error("Review must reference its exact Field Report delegation ID");
  if (!String(input.claim || "").trim() || input.claim !== delegation?.claim) throw new Error("Review claim must match its exact Field Report delegation");
  if (!String(input.reviewerTaskId || "").trim()) throw new Error("Review requires a reviewer task or provider-run ID");
  if (!SHA.test(input.head || "") || !SHA.test(input.baseHead || "")) throw new Error("Review requires exact head and baseHead SHAs");
  if (input.kind === "commit" && !SHA.test(input.tree || "")) throw new Error("Commit review requires the exact staged tree SHA");
  if (input.kind === "final" && input.tree != null) throw new Error("Final review must not include a staged tree");
  if (delegation.kind !== input.kind || delegation.role !== input.role || delegation.head !== input.head || delegation.baseHead !== input.baseHead || (input.kind === "commit" && delegation.tree !== input.tree)) throw new Error("Review target does not match its delegation");
  const providers = { codex: "openai", cursor: "cursor", claude: "anthropic" };
  if (input.provider !== providers[input.reviewerFamily]) throw new Error(`Provider does not match reviewer family ${input.reviewerFamily}`);
  if (!String(input.model || "").trim()) throw new Error("Review requires the model used");
  if (!["native", "cli"].includes(input.route) || input.route !== delegation?.route) throw new Error("Review route must match its exact delegation");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim())) throw new Error("Review unresolved must be a nonblank string array");
  if (input.verdict === "NO_GO" && !input.findings.length && !input.unresolved.length) throw new Error("NO_GO requires at least one durable finding or unresolved item");
  if (!String(input.summary || "").trim()) throw new Error("Review requires a summary");
  for (const key of SCORE_KEYS) assertScore(input.scores?.[key], key);
  for (const key of SCORE_KEYS) if (!String(input.scoreRationale?.[key] || "").trim()) throw new Error(`${key} requires explanatory rationale`);
  for (const [key, values] of Object.entries(SIGNAL_VALUES)) if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(", ")}`);
  if (!String(input.simplerPath || "").trim()) throw new Error("simplerPath must explain alternatives considered and discarded, or state that none were found");
  if (input.reconciled != null) {
    if (!Array.isArray(input.reconciled)) throw new Error("reconciled must be an array of finding reconciliations");
    for (const entry of input.reconciled) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each reconciled entry must be an object");
      if (!String(entry.findingId || "").trim() || !["resolved", "rejected", "still_present"].includes(entry.disposition) || !String(entry.rationale || "").trim()) throw new Error("Each reconciled entry requires findingId, disposition resolved|rejected|still_present, and evidence-based rationale");
    }
    const ids = input.reconciled.map((entry) => entry.findingId);
    if (new Set(ids).size !== ids.length) throw new Error("reconciled entries must reference distinct finding IDs");
  }
  return { ...input, findings: [...input.findings], unresolved: [...input.unresolved], scores: { ...input.scores }, ...(input.reconciled ? { reconciled: input.reconciled.map((entry) => ({ ...entry })) } : {}) };
}

export function findingLedger(reviews) {
  const entries = [];
  let counter = 0;
  for (const review of reviews) {
    if (review.legacy === true) continue;
    for (const [category, items] of [["finding", review.findings], ["unresolved", review.unresolved]]) {
      for (const text of items || []) {
        counter += 1;
        entries.push({ id: `F${counter}`, category, text, role: review.role, claim: review.claim });
      }
    }
  }
  return entries;
}

// Adverse evidence is durable across candidate evolution AND claim changes:
// scoping durability to the owner-editable claim would let a claim edit
// launder every outstanding issue. An issue inapplicable to a revised claim
// is explicitly rejected with that rationale; a fundamentally different
// outcome uses a new workstream.
export function outstandingFindings(reviews, claim) {
  const state = new Map();
  for (const review of reviews) {
    if (review.legacy === true) continue;
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

const accepted = (review) => review?.legacy !== true && review?.verdict === "GO" && review.reviewComplete === true && review.independent === true && hasCompleteEvidence(review) && !(review.findings || []).length && !(review.unresolved || []).length;

function latestFor(reviews, predicate) { return [...reviews].reverse().find(predicate) || null; }

function matchesTarget(value, kind, target, claim, claimRevision) {
  return value.kind === kind && value.claim === claim && (value.claimRevision ?? 1) === claimRevision && value.head === target.head && value.baseHead === target.baseHead && (kind !== "commit" || value.tree === target.tree);
}

export function evaluateGate({ kind, target, workstream, reviews, delegations = [] }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = reviews.filter((review) => review.legacy !== true && matchesTarget(review, kind, target, claim, claimRevision));
  const created = delegations.filter((item) => item.event === "created" && item.type === "review" && matchesTarget(item, kind, target, claim, claimRevision));
  const attempts = Object.fromEntries(REVIEWER_FAMILIES.map((family) => [family, created.filter((item) => item.reviewerFamily === family)]));
  const lanes = Object.fromEntries(REVIEWER_FAMILIES.map((family) => [family, latestFor(matching, (review) => review.reviewerFamily === family && accepted(review)) || latestFor(matching, (review) => review.reviewerFamily === family)]));
  const reasons = [];
  let completedGos = 0;
  for (const family of REVIEWER_FAMILIES) {
    const familyAttempts = attempts[family];
    if (!familyAttempts.length) { reasons.push(`missing ${family} review attempt`); continue; }
    const review = lanes[family];
    for (const attempt of familyAttempts) {
      const completed = matching.some((item) => item.delegationId === attempt.id);
      const failed = delegations.some((item) => item.id === attempt.id && item.event === "failed");
      if (!completed && !failed) reasons.push(`${family} review attempt ${attempt.id} is not terminal`);
    }
    if (accepted(review)) completedGos += 1;
  }
  if (completedGos < 2) reasons.push(`requires two completed finding-free GO reviews; received ${completedGos}`);
  const reviewerIds = Object.values(lanes).filter(Boolean).map((review) => review.reviewerTaskId);
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("Completed reviews require distinct reviewer task IDs");
  if (workstream.ownerTaskId && reviewerIds.includes(workstream.ownerTaskId)) reasons.push("Workstream owner cannot satisfy an independent review");
  for (const review of Object.values(lanes).filter(Boolean)) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push(`${review.reviewerFamily} reviewer was the workstream owner when its review brief was created`);
  }
  for (const finding of outstandingFindings(reviews, claim)) reasons.push(`unreconciled ${finding.role} ${finding.category} ${finding.id}: ${finding.text}`);
  return { ready: reasons.length === 0, kind, target, reasons, lanes, attempts };
}

export function publicationReasons({ project, target, checkout, pr }) {
  const reasons = [];
  if (checkout.dirty) reasons.push("checkout has uncommitted changes");
  if (pr.state !== "OPEN") reasons.push(`PR #${pr.number} is not open`);
  if (!pr.isDraft) reasons.push(`PR #${pr.number} is already non-draft`);
  if (pr.headRefOid !== target.head) reasons.push("PR head does not match the reviewed exact head");
  if (pr.headRefName !== target.branch) reasons.push(`PR head branch ${pr.headRefName} does not match reviewed branch ${target.branch}`);
  if (pr.baseRefName !== project.baseBranch) reasons.push(`PR base ${pr.baseRefName} does not match configured base ${project.baseBranch}`);
  const accepted = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const checks = pr.statusCheckRollup || [];
  if (checks.some((check) => check.conclusion && !accepted.has(check.conclusion))) reasons.push("GitHub checks include an unsuccessful conclusion");
  if (checks.some((check) => !check.conclusion && !accepted.has(check.state))) reasons.push("GitHub checks are incomplete or unsuccessful");
  return reasons;
}

export function workstreamPublicationReasons({ workstream, workstreams, pr }) {
  const reasons = [];
  const openQuestions = workstream.questions.filter((question) => question.status === "open");
  if (openQuestions.length) reasons.push(`open workstream questions: ${openQuestions.map((question) => question.id).join(", ")}`);
  const duplicateOwners = workstreams.filter((other) => other.id !== workstream.id && other.project === workstream.project && other.pullRequests.includes(pr.number));
  if (duplicateOwners.length) reasons.push(`PR #${pr.number} is also claimed by workstream${duplicateOwners.length === 1 ? "" : "s"} ${duplicateOwners.map((other) => other.id).join(", ")}`);
  return reasons;
}

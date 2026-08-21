const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORE_KEYS = ["mergeReadiness", "structuralRisk", "implementationQuality", "evidenceConfidence", "outcomeConfidence"];
const SIGNAL_VALUES = {
  necessity: ["necessary", "questionable_roi"],
  scopeDrift: ["none", "minor", "material"],
  contractIntegrity: ["sound", "mixed", "broken"],
  evidenceQuality: ["strong", "mixed", "weak"]
};
export const SOL_ROLES = ["deep-code-review", "structural-challenge"];

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
  if (![...SOL_ROLES, "fable-challenge"].includes(input.role)) throw new Error("Unknown review role");
  if (!UUID.test(input.delegationId || "") || input.delegationId !== delegation?.id) throw new Error("Review must reference its exact Field Report delegation ID");
  if (!String(input.claim || "").trim() || input.claim !== delegation?.claim) throw new Error("Review claim must match its exact Field Report delegation");
  if (!String(input.reviewerTaskId || "").trim()) throw new Error("Review requires a reviewer task or provider-run ID");
  if (!SHA.test(input.head || "") || !SHA.test(input.baseHead || "")) throw new Error("Review requires exact head and baseHead SHAs");
  if (input.kind === "commit" && !SHA.test(input.tree || "")) throw new Error("Commit review requires the exact staged tree SHA");
  if (input.kind === "final" && input.tree != null) throw new Error("Final review must not include a staged tree");
  if (delegation.kind !== input.kind || delegation.role !== input.role || delegation.head !== input.head || delegation.baseHead !== input.baseHead || (input.kind === "commit" && delegation.tree !== input.tree)) throw new Error("Review target does not match its delegation");
  if (input.role === "fable-challenge") {
    if (input.provider !== "anthropic" || input.model !== "anthropic.claude-fable-5" || input.route !== "claude-aws") throw new Error("Fable review requires anthropic.claude-fable-5 through claude-aws");
  } else if (input.provider !== "openai" || input.model !== "gpt-5.6-sol") throw new Error("Sol review requires gpt-5.6-sol through OpenAI");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim())) throw new Error("Review unresolved must be a nonblank string array");
  if (!String(input.summary || "").trim()) throw new Error("Review requires a summary");
  for (const key of SCORE_KEYS) assertScore(input.scores?.[key], key);
  for (const key of SCORE_KEYS) if (!String(input.scoreRationale?.[key] || "").trim()) throw new Error(`${key} requires explanatory rationale`);
  for (const [key, values] of Object.entries(SIGNAL_VALUES)) if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(", ")}`);
  if (!String(input.simplerPath || "").trim()) throw new Error("simplerPath must explain alternatives considered and discarded, or state that none were found");
  if (input.role !== "fable-challenge" && typeof input.miniEligible !== "boolean") throw new Error("Sol reviews must state miniEligible true or false");
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

export function evaluateGate({ kind, target, workstream, reviews }) {
  const claim = workstream.claim ?? workstream.summary;
  const claimRevision = workstream.claimRevision ?? 1;
  const matching = reviews.filter((review) => review.legacy !== true && review.kind === kind && review.claim === claim && (review.claimRevision ?? 1) === claimRevision && review.head === target.head && review.baseHead === target.baseHead && (kind !== "commit" || review.tree === target.tree));
  const sol = Object.fromEntries(SOL_ROLES.map((role) => [role, latestFor(matching, (review) => review.role === role)]));
  const fable = latestFor(matching, (review) => review.role === "fable-challenge");
  const reasons = [];
  for (const role of SOL_ROLES) {
    if (!sol[role]) reasons.push(`missing ${role} Sol review`);
    else if (!accepted(sol[role])) reasons.push(`${role} is not a finding-free GO`);
  }
  const solIds = SOL_ROLES.map((role) => sol[role]?.reviewerTaskId).filter(Boolean);
  if (solIds.length === 2 && new Set(solIds).size !== 2) reasons.push("Sol roles require distinct reviewer task IDs");
  if (workstream.ownerTaskId && solIds.includes(workstream.ownerTaskId)) reasons.push("Workstream owner cannot satisfy an independent Sol review lane");
  for (const review of Object.values(sol).filter(Boolean)) {
    if (review.ownerTaskIdAtBrief && review.ownerTaskIdAtBrief === review.reviewerTaskId) reasons.push(`${review.role} reviewer was the workstream owner when its review brief was created`);
  }
  const mini = kind === "final" && workstream.reviewClass === "mini";
  if (mini) {
    if (!workstream.miniClassification?.eligible || workstream.miniClassification?.head !== target.head || workstream.miniClassification?.baseHead !== target.baseHead) reasons.push("mini classification is missing or stale");
    for (const role of SOL_ROLES) if (sol[role] && sol[role].miniEligible !== true) reasons.push(`${role} did not affirm mini eligibility`);
  }
  if (kind === "final" && !mini) {
    if (!fable) reasons.push("missing Fable review through claude-aws");
    else if (!accepted(fable)) reasons.push("Fable review is not a finding-free GO");
  }
  for (const finding of outstandingFindings(reviews, claim)) reasons.push(`unreconciled ${finding.role} ${finding.category} ${finding.id}: ${finding.text}`);
  return { ready: reasons.length === 0, kind, target, reviewClass: mini ? "mini" : "full", reasons, lanes: { ...sol, fable: kind === "final" ? fable : null } };
}

export function miniEligibility({ files, additions, deletions, project }) {
  const policy = project.miniReview;
  const risky = files.filter((file) => policy.riskyPaths.some((pattern) => file.toLowerCase().includes(pattern.toLowerCase())));
  const reasons = [];
  if (files.length > policy.maxFiles) reasons.push(`${files.length} changed files exceeds ${policy.maxFiles}`);
  if (additions + deletions > policy.maxChangedLines) reasons.push(`${additions + deletions} changed lines exceeds ${policy.maxChangedLines}`);
  if (risky.length) reasons.push(`high-risk paths changed: ${risky.join(", ")}`);
  return { eligible: reasons.length === 0, files, additions, deletions, risky, reasons };
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

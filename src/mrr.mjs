function exactHead(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

const FULL_FLEET_POLICY = Object.freeze({
  requireReviewerIds: true,
  minSolReviewers: 2,
  requireFableViaClaudeAws: true
});
const DEFAULT_POLICY = Object.freeze({ mode: "full", reason: null, ...FULL_FLEET_POLICY });

function providerFor(event) {
  const explicit = String(event.metadata?.provider || "").toLowerCase();
  const model = String(event.metadata?.model || "").toLowerCase();
  const derived = /^(anthropic\.)?claude-/.test(model) ? "anthropic" : /^(openai\.|gpt-)/.test(model) ? "openai" : null;
  return derived && (!explicit || explicit === derived) ? derived : null;
}

function durableReviewerId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function isSol(event) {
  return event.metadata?.model === "gpt-5.6-sol"
    && providerFor(event) === "openai"
    && event.metadata?.reviewerIdentityVerified === true
    && event.metadata?.provenanceVerified === true
    && /^[0-9a-f]{64}$/i.test(event.metadata?.evidenceDigest || "");
}

function isVerifiedFable(event) {
  return ["anthropic.claude-fable-5", "claude-fable-5"].includes(event.metadata?.model)
    && event.metadata?.provider === "anthropic"
    && event.metadata?.route === "claude-aws"
    && event.metadata?.provenanceVerified === true
    && /^[0-9a-f]{64}$/i.test(event.metadata?.evidenceDigest || "");
}

function roleFor(event) {
  const explicit = String(event.metadata?.reviewRole || "").toLowerCase();
  if (["deep-code-review", "structural-challenge"].includes(explicit)) return explicit;
  const identity = `${event.metadata?.model || ""} ${event.metadata?.reviewer || ""} ${event.actor || ""}`.toLowerCase();
  if (/claude|fable/.test(identity)) return "structural-challenge";
  if (/gpt-5\.6-sol|codex[^\n]*sol|sol[^\n]*codex/.test(identity) && /^(high|xhigh)$/i.test(event.metadata?.reasoning || "")) return "deep-code-review";
  return "other";
}

function policyFor(stream) {
  const policy = stream.reviewPolicy || {};
  const mode = policy.mode || "full";
  const full = mode === "full";
  return {
    mode,
    reason: policy.reason || null,
    userAuthorized: policy.userAuthorized === true,
    minProviderFamilies: nonNegativeInteger(policy.minProviderFamilies),
    requireReviewerIds: full || policy.requireReviewerIds === true,
    minSolReviewers: full ? Math.max(FULL_FLEET_POLICY.minSolReviewers, nonNegativeInteger(policy.minSolReviewers)) : nonNegativeInteger(policy.minSolReviewers),
    requireFableViaClaudeAws: full || policy.requireFableViaClaudeAws === true
  };
}

export function evaluateMrr(stream) {
  const codeOutcome = Boolean(stream.branch || (stream.prs || []).length || (stream.commits || []).length);
  if (!codeOutcome) return { required: false, ready: true, head: null, reasons: [], policy: DEFAULT_POLICY, lanes: { deepCode: null, structuralChallenge: null } };

  const configuredPolicy = policyFor(stream);
  const policy = { ...configuredPolicy, mode: "full", reason: null, userAuthorized: false, minSolReviewers: Math.max(FULL_FLEET_POLICY.minSolReviewers, configuredPolicy.minSolReviewers), requireFableViaClaudeAws: true, requireReviewerIds: true };
  const policyValid = policy.mode === "full" || Boolean(policy.reason && policy.userAuthorized);
  const head = stream.assessment?.currentHead || (stream.prs || []).find((pr) => pr.state === "OPEN" && pr.headRefName === stream.branch)?.headRefOid || null;
  const current = (stream.reviewPasses || []).filter((event) => exactHead(event.metadata?.head, head)).sort((left, right) => new Date(left.at || 0) - new Date(right.at || 0));
  const eligible = policy.mode === "full" ? current.filter((event) => isSol(event) || isVerifiedFable(event)) : current;
  const completed = eligible.filter((event) => event.metadata?.reviewComplete === true && event.metadata?.independent !== false);
  const latestByReviewer = [...new Map(completed.map((event) => [event.metadata?.reviewerId || `${event.metadata?.reviewer || event.actor}:${roleFor(event)}`, event])).values()];
  const latestDeepCode = completed.findLast((event) => roleFor(event) === "deep-code-review") || null;
  const latestStructural = completed.findLast((event) => roleFor(event) === "structural-challenge") || null;
  const latestIndependent = completed.at(-1) || null;
  const latestDelta = completed.findLast((event) => event.metadata?.reviewScope === "delta" && /^[0-9a-f]{40}$/i.test(event.metadata?.baseHead || "")) || null;
  const requiredPasses = policy.mode === "full" ? [latestDeepCode, latestStructural].filter(Boolean) : policy.mode === "delta" ? [latestDelta].filter(Boolean) : policy.mode === "single-independent" ? [latestIndependent].filter(Boolean) : [];
  const accepted = (event) => {
    if (!event || event.metadata?.verdict !== "GO" || (event.metadata?.findings || []).length || (event.metadata?.unresolved || []).length) return false;
    const hasOwnerProvenance = Object.hasOwn(event.metadata || {}, "orchestratorAtReview");
    return hasOwnerProvenance && event.metadata?.reviewerId !== event.metadata?.orchestratorAtReview;
  };
  const deepCode = accepted(latestDeepCode) ? latestDeepCode : null;
  const structuralChallenge = accepted(latestStructural) ? latestStructural : null;
  const reconciledPasses = policy.mode === "full" ? latestByReviewer : requiredPasses;
  const blockingVerdicts = reconciledPasses.filter((event) => event.metadata?.verdict !== "GO");
  const reconciledFindings = reconciledPasses.flatMap((event) => event.metadata?.findings || []);
  const reconciledUnresolved = reconciledPasses.flatMap((event) => event.metadata?.unresolved || []);
  const reasons = [];
  if (!head) reasons.push("current branch head is unresolved; refresh sources first");
  if (policy.mode !== "full" && !policy.reason) reasons.push(`review policy ${policy.mode} requires an explicit reason`);
  if (policy.mode !== "full" && !policy.userAuthorized) reasons.push(`review policy ${policy.mode} requires durable user authorization`);
  if (policy.mode === "full" && !deepCode) reasons.push("missing completed deep-code-review exact-head pass");
  if (policy.mode === "full" && !structuralChallenge) reasons.push("missing completed structural-challenge exact-head pass");
  if (policy.mode === "single-independent" && !accepted(latestIndependent)) reasons.push("missing completed independent exact-head pass");
  if (policy.mode === "delta" && !accepted(latestDelta)) reasons.push("missing completed independent delta review with an exact base head");
  const acceptedPasses = requiredPasses.filter(accepted);
  const reviewerIds = acceptedPasses.map((event) => event.metadata?.reviewerId).filter(durableReviewerId);
  if (policy.requireReviewerIds && reviewerIds.length !== acceptedPasses.length) reasons.push("required review passes must include durable reviewer IDs");
  if (policy.requireReviewerIds && new Set(reviewerIds).size !== reviewerIds.length) reasons.push("required review passes must come from distinct reviewers");
  if (policy.requireReviewerIds && stream.orchestrator && reviewerIds.includes(stream.orchestrator)) reasons.push("the workstream orchestrator cannot satisfy an independent review lane");
  const providers = [...new Set(acceptedPasses.map(providerFor).filter(Boolean))];
  const requiredProviderFamilies = policy.mode === "full" ? policy.minProviderFamilies : policy.mode === "none" ? 0 : Math.min(policy.minProviderFamilies, 1);
  if (requiredProviderFamilies > providers.length) reasons.push(`review policy requires ${requiredProviderFamilies} provider families; found ${providers.length}`);
  const acceptedFleet = latestByReviewer.filter(accepted);
  const orchestratorFleetPasses = acceptedFleet.filter((event) => stream.orchestrator && event.metadata?.reviewerId === stream.orchestrator);
  if (policy.mode === "full" && orchestratorFleetPasses.length) reasons.push("the workstream orchestrator cannot count toward the independent MRR fleet");
  const solReviewerIds = new Set(acceptedFleet.filter(isSol).map((event) => event.metadata?.reviewerId).filter(durableReviewerId));
  if (policy.mode === "full" && solReviewerIds.size < policy.minSolReviewers) reasons.push(`full MRR requires ${policy.minSolReviewers} distinct Sol reviewers; found ${solReviewerIds.size}`);
  const solDeepPass = acceptedFleet.findLast((event) => isSol(event) && roleFor(event) === "deep-code-review");
  const solStructuralPass = acceptedFleet.findLast((event) => isSol(event) && roleFor(event) === "structural-challenge");
  if (policy.mode === "full" && !solDeepPass) reasons.push("full MRR requires a witnessed Sol deep-code-review lane");
  if (policy.mode === "full" && !solStructuralPass) reasons.push("full MRR requires a witnessed Sol structural-challenge lane");
  const fablePass = acceptedFleet.find((event) => isVerifiedFable(event) && durableReviewerId(event.metadata?.reviewerId));
  if (policy.mode === "full" && policy.requireFableViaClaudeAws && !fablePass) reasons.push("full MRR requires a completed Fable review through claude-aws");
  if (blockingVerdicts.length) reasons.push(`${blockingVerdicts.length} required current-head review verdict${blockingVerdicts.length === 1 ? " is" : "s are"} not GO`);
  if (reconciledFindings.length) reasons.push(`${reconciledFindings.length} required current-head reviewer finding${reconciledFindings.length === 1 ? " remains" : "s remain"} unreconciled`);
  if (reconciledUnresolved.length) reasons.push(`${reconciledUnresolved.length} required current-head reviewer finding${reconciledUnresolved.length === 1 ? " remains" : "s remain"} unresolved`);
  return {
    required: true,
    ready: Boolean(head && policyValid && (policy.mode === "none" || (policy.mode === "full" && deepCode && structuralChallenge) || (policy.mode === "single-independent" && accepted(latestIndependent)) || (policy.mode === "delta" && accepted(latestDelta))) && !blockingVerdicts.length && !reconciledFindings.length && !reconciledUnresolved.length && !reasons.length),
    head,
    policy,
    reasons,
    currentPassCount: current.length,
    fleet: { accepted: acceptedFleet.length, solReviewers: solReviewerIds.size, fableViaClaudeAws: Boolean(fablePass) },
    lanes: {
      deepCode: deepCode ? { reviewer: deepCode.metadata?.reviewer || deepCode.actor, reviewerId: deepCode.metadata?.reviewerId, provider: providerFor(deepCode), model: deepCode.metadata?.model, reasoning: deepCode.metadata?.reasoning, verdict: deepCode.metadata?.verdict } : null,
      structuralChallenge: structuralChallenge ? { reviewer: structuralChallenge.metadata?.reviewer || structuralChallenge.actor, reviewerId: structuralChallenge.metadata?.reviewerId, provider: providerFor(structuralChallenge), model: structuralChallenge.metadata?.model, verdict: structuralChallenge.metadata?.verdict } : null
    }
  };
}

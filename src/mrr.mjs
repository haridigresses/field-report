function exactHead(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

const DEFAULT_POLICY = { mode: "full", reason: null };

function providerFor(event) {
  const explicit = String(event.metadata?.provider || "").toLowerCase();
  const model = String(event.metadata?.model || "").toLowerCase();
  const derived = /^(anthropic\.)?claude-/.test(model) ? "anthropic" : /^(openai\.|gpt-)/.test(model) ? "openai" : null;
  return derived && (!explicit || explicit === derived) ? derived : null;
}

function durableReviewerId(value) {
  return Boolean(value && !String(value).startsWith("cwd:"));
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
  const policy = stream.reviewPolicy || DEFAULT_POLICY;
  return {
    mode: policy.mode || "full",
    reason: policy.reason || null,
    minProviderFamilies: Number(policy.minProviderFamilies || 0),
    requireReviewerIds: policy.requireReviewerIds === true
  };
}

export function evaluateMrr(stream) {
  const codeOutcome = Boolean(stream.branch || (stream.prs || []).length || (stream.commits || []).length);
  if (!codeOutcome) return { required: false, ready: true, head: null, reasons: [], policy: DEFAULT_POLICY, lanes: { deepCode: null, structuralChallenge: null } };

  const policy = policyFor(stream);
  const policyValid = policy.mode === "full" || Boolean(policy.reason);
  const head = stream.assessment?.currentHead || (stream.prs || []).find((pr) => pr.state === "OPEN" && pr.headRefName === stream.branch)?.headRefOid || null;
  const current = (stream.reviewPasses || []).filter((event) => exactHead(event.metadata?.head, head)).sort((left, right) => new Date(left.at || 0) - new Date(right.at || 0));
  const completed = current.filter((event) => event.metadata?.reviewComplete === true && event.metadata?.independent !== false);
  const latestDeepCode = completed.findLast((event) => roleFor(event) === "deep-code-review") || null;
  const latestStructural = completed.findLast((event) => roleFor(event) === "structural-challenge") || null;
  const latestIndependent = completed.at(-1) || null;
  const latestDelta = completed.findLast((event) => event.metadata?.reviewScope === "delta" && /^[0-9a-f]{40}$/i.test(event.metadata?.baseHead || "")) || null;
  const requiredPasses = policy.mode === "full" ? [latestDeepCode, latestStructural].filter(Boolean) : policy.mode === "delta" ? [latestDelta].filter(Boolean) : policy.mode === "single-independent" ? [latestIndependent].filter(Boolean) : [];
  const accepted = (event) => event && event.metadata?.verdict === "GO" && !(event.metadata?.unresolved || []).length;
  const deepCode = accepted(latestDeepCode) ? latestDeepCode : null;
  const structuralChallenge = accepted(latestStructural) ? latestStructural : null;
  const noGo = requiredPasses.filter((event) => event.metadata?.verdict === "NO_GO");
  const unresolved = requiredPasses.flatMap((event) => event.metadata?.unresolved || []);
  const reasons = [];
  if (!head) reasons.push("current branch head is unresolved; refresh sources first");
  if (!policyValid) reasons.push(`review policy ${policy.mode} requires an explicit reason`);
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
  if (noGo.length) reasons.push(`${noGo.length} current-head NO-GO pass${noGo.length === 1 ? "" : "es"} must be reconciled`);
  if (unresolved.length) reasons.push(`${unresolved.length} current-head reviewer finding${unresolved.length === 1 ? " remains" : "s remain"} unresolved`);
  return {
    required: true,
    ready: Boolean(head && policyValid && (policy.mode === "none" || (policy.mode === "full" && deepCode && structuralChallenge) || (policy.mode === "single-independent" && accepted(latestIndependent)) || (policy.mode === "delta" && accepted(latestDelta))) && !noGo.length && !unresolved.length && !reasons.length),
    head,
    policy,
    reasons,
    currentPassCount: current.length,
    lanes: {
      deepCode: deepCode ? { reviewer: deepCode.metadata?.reviewer || deepCode.actor, reviewerId: deepCode.metadata?.reviewerId, provider: providerFor(deepCode), model: deepCode.metadata?.model, reasoning: deepCode.metadata?.reasoning, verdict: deepCode.metadata?.verdict } : null,
      structuralChallenge: structuralChallenge ? { reviewer: structuralChallenge.metadata?.reviewer || structuralChallenge.actor, reviewerId: structuralChallenge.metadata?.reviewerId, provider: providerFor(structuralChallenge), model: structuralChallenge.metadata?.model, verdict: structuralChallenge.metadata?.verdict } : null
    }
  };
}

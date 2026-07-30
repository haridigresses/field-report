const ROLES = ["deep-code-review", "structural-challenge"];
const isSol = (event) => event.metadata?.model === "gpt-5.6-sol"
  && event.metadata?.provider === "openai"
  && event.metadata?.reviewerIdentityVerified === true
  && event.metadata?.provenanceVerified === true
  && /^[0-9a-f]{64}$/i.test(event.metadata?.evidenceDigest || "");

export function evaluateCommitPanel({ tree, baseHead, events = [], orchestrator = null }) {
  const current = events.filter((event) => event.type === "commit_review" && event.metadata?.tree === tree && event.metadata?.baseHead === baseHead && event.metadata?.reviewComplete === true && isSol(event));
  const independentlyProven = (event) => {
    const hasOwnerProvenance = Object.hasOwn(event.metadata || {}, "orchestratorAtReview");
    return hasOwnerProvenance && event.metadata?.reviewerId !== event.metadata?.orchestratorAtReview;
  };
  const latest = Object.fromEntries(ROLES.map((role) => [role, current.findLast((event) => event.metadata?.reviewRole === role && independentlyProven(event)) || null]));
  const lanes = Object.fromEntries(ROLES.map((role) => [role, latest[role]?.metadata?.verdict === "GO" && !(latest[role].metadata?.findings || []).length && !(latest[role].metadata?.unresolved || []).length ? latest[role] : null]));
  const accepted = ROLES.map((role) => lanes[role]).filter(Boolean);
  const reviewerIds = accepted.map((event) => event.metadata?.reviewerId).filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "")));
  const reasons = [];
  for (const role of ROLES) if (!lanes[role]) reasons.push(`missing local ${role} review for staged tree`);
  for (const role of ROLES) if (latest[role] && !lanes[role]) reasons.push(`latest local ${role} review is not a finding-free GO`);
  for (const role of ROLES) if (lanes[role] && !isSol(lanes[role])) reasons.push(`local ${role} review must come from a Sol agent`);
  if (reviewerIds.length !== accepted.length) reasons.push("local commit reviews require durable reviewer IDs");
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("local commit review roles must come from distinct reviewers");
  if (orchestrator && reviewerIds.includes(orchestrator)) reasons.push("the workstream orchestrator cannot satisfy a local commit review lane");
  if (!baseHead) reasons.push("commit base head is unresolved");
  return { ready: Boolean(tree && baseHead && !reasons.length), tree, baseHead, reasons, lanes };
}

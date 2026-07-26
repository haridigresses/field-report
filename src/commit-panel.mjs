const ROLES = ["deep-code-review", "structural-challenge"];

export function evaluateCommitPanel({ tree, baseHead, events = [], orchestrator = null }) {
  const current = events.filter((event) => event.type === "commit_review" && event.metadata?.tree === tree && event.metadata?.baseHead === baseHead && event.metadata?.reviewComplete === true);
  const lanes = Object.fromEntries(ROLES.map((role) => [role, current.findLast((event) => event.metadata?.reviewRole === role && event.metadata?.verdict === "GO") || null]));
  const accepted = ROLES.map((role) => lanes[role]).filter(Boolean);
  const reviewerIds = accepted.map((event) => event.metadata?.reviewerId).filter((value) => value && !String(value).startsWith("cwd:"));
  const reasons = [];
  for (const role of ROLES) if (!lanes[role]) reasons.push(`missing local ${role} review for staged tree`);
  if (reviewerIds.length !== accepted.length) reasons.push("local commit reviews require durable reviewer IDs");
  if (new Set(reviewerIds).size !== reviewerIds.length) reasons.push("local commit review roles must come from distinct reviewers");
  if (orchestrator && reviewerIds.includes(orchestrator)) reasons.push("the workstream orchestrator cannot satisfy a local commit review lane");
  if (!baseHead) reasons.push("commit base head is unresolved");
  return { ready: Boolean(tree && baseHead && !reasons.length), tree, baseHead, reasons, lanes };
}

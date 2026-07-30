import { evaluateMrr } from "./mrr.mjs";

function exactHead(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

export function evaluateRelease({ stream, checkout, remoteHead, pr, prOwners = [], mrr: suppliedMrr }) {
  const reasons = [];
  const branch = stream.branch || null;
  const localHead = checkout?.head || null;
  const mrr = suppliedMrr || evaluateMrr({
    ...stream,
    assessment: { ...(stream.assessment || {}), currentHead: remoteHead || null }
  });

  if (!branch) reasons.push("workstream branch is unresolved");
  if (stream.publicationHold?.reason) reasons.push(`publication hold: ${stream.publicationHold.reason}`);
  if (!checkout?.branch || checkout.branch === "HEAD") reasons.push("checkout branch is unresolved");
  else if (branch && checkout.branch !== branch) reasons.push(`checkout branch ${checkout.branch} does not match workstream branch ${branch}`);
  if (!localHead) reasons.push("checkout head is unresolved");
  if (checkout?.dirty) reasons.push("checkout has uncommitted changes; commit or set them aside before asserting release readiness");
  if (!remoteHead) reasons.push("remote branch head is unresolved; push the exact candidate head first");
  else if (localHead && !exactHead(localHead, remoteHead)) reasons.push(`checkout head ${localHead.slice(0, 8)} does not match remote head ${remoteHead.slice(0, 8)}`);
  if (!pr) reasons.push("no GitHub pull request exists for the workstream branch; create it as a draft");
  else {
    if (!(stream.prs || []).some((candidate) => Number(candidate.number) === Number(pr.number))) reasons.push(`PR #${pr.number} is not linked to this workstream`);
    if (prOwners.length > 1) reasons.push(`PR #${pr.number} is linked to multiple workstreams: ${prOwners.join(", ")}`);
    if (String(pr.state || "").toUpperCase() !== "OPEN") reasons.push(`PR #${pr.number} is ${String(pr.state || "unknown").toLowerCase()}, not open`);
    if (pr.isDraft !== true) reasons.push(`PR #${pr.number} is already marked ready; publication must remain draft until this release check passes`);
    if (branch && pr.headRefName !== branch) reasons.push(`PR #${pr.number} head branch ${pr.headRefName || "unknown"} does not match workstream branch ${branch}`);
    if (remoteHead && !exactHead(pr.headRefOid, remoteHead)) reasons.push(`PR #${pr.number} head ${String(pr.headRefOid || "unknown").slice(0, 8)} does not match remote head ${remoteHead.slice(0, 8)}`);
  }
  if (!mrr.required) reasons.push("MRR is not required because this is classified as non-code; a PR-backed release must use a code workstream");
  else if (remoteHead && !exactHead(mrr.head, remoteHead)) reasons.push(`MRR reviewed head ${String(mrr.head || "unresolved").slice(0, 8)} does not match remote head ${remoteHead.slice(0, 8)}`);
  else if (!mrr.ready) reasons.push(...mrr.reasons.map((reason) => `MRR: ${reason}`));

  return {
    ready: reasons.length === 0,
    branch,
    head: remoteHead || localHead,
    pr: pr ? { number: pr.number, isDraft: Boolean(pr.isDraft), state: pr.state } : null,
    mrr,
    reasons
  };
}

function exactHead(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

function laneFor(event) {
  const identity = `${event.metadata?.model || ""} ${event.metadata?.reviewer || ""} ${event.actor || ""}`.toLowerCase();
  if (/claude|fable/.test(identity)) return "fable";
  if (/gpt-5\.6-sol|codex[^\n]*sol|sol[^\n]*codex/.test(identity) && /^(high|xhigh)$/i.test(event.metadata?.reasoning || "")) return "codex-sol";
  return "other";
}

export function evaluateMrr(stream) {
  const codeOutcome = Boolean(stream.branch || (stream.prs || []).length || (stream.commits || []).length);
  if (!codeOutcome) return { required: false, ready: true, head: null, reasons: [], lanes: { fable: null, codexSol: null } };

  const head = stream.assessment?.currentHead || (stream.prs || []).find((pr) => pr.state === "OPEN" && pr.headRefName === stream.branch)?.headRefOid || null;
  const current = (stream.reviewPasses || []).filter((event) => exactHead(event.metadata?.head, head)).sort((left, right) => new Date(left.at || 0) - new Date(right.at || 0));
  const completed = current.filter((event) => event.metadata?.reviewComplete === true && event.metadata?.independent !== false);
  const latestFable = completed.findLast((event) => laneFor(event) === "fable") || null;
  const latestCodexSol = completed.findLast((event) => laneFor(event) === "codex-sol") || null;
  const requiredPasses = [latestCodexSol, latestFable].filter(Boolean);
  const accepted = (event) => event && event.metadata?.verdict !== "NO_GO" && !(event.metadata?.unresolved || []).length;
  const fable = accepted(latestFable) ? latestFable : null;
  const codexSol = accepted(latestCodexSol) ? latestCodexSol : null;
  const noGo = requiredPasses.filter((event) => event.metadata?.verdict === "NO_GO");
  const unresolved = requiredPasses.flatMap((event) => event.metadata?.unresolved || []);
  const reasons = [];
  if (!head) reasons.push("current branch head is unresolved; refresh sources first");
  if (!codexSol) reasons.push("missing completed gpt-5.6-sol high-reasoning exact-head pass");
  if (!fable) reasons.push("missing completed Fable review via claude-aws on the exact head");
  if (noGo.length) reasons.push(`${noGo.length} current-head NO-GO pass${noGo.length === 1 ? "" : "es"} must be reconciled`);
  if (unresolved.length) reasons.push(`${unresolved.length} current-head reviewer finding${unresolved.length === 1 ? " remains" : "s remain"} unresolved`);
  return {
    required: true,
    ready: Boolean(head && fable && codexSol && !noGo.length && !unresolved.length),
    head,
    reasons,
    currentPassCount: current.length,
    lanes: {
      fable: fable ? { reviewer: fable.metadata?.reviewer || fable.actor, model: fable.metadata?.model, verdict: fable.metadata?.verdict } : null,
      codexSol: codexSol ? { reviewer: codexSol.metadata?.reviewer || codexSol.actor, model: codexSol.metadata?.model, reasoning: codexSol.metadata?.reasoning, verdict: codexSol.metadata?.verdict } : null
    }
  };
}

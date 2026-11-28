import { configSource, normalizeId, REVIEW_ROLES, seatFor } from "./seats.mjs";

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
export { REVIEW_ROLES };

function assertScore(value, key) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${key} must be an integer from 0 to 100`);
}

export function seatModelsFor(item) {
  return Array.isArray(item?.seatModels) ? item.seatModels : null;
}

export function fitsSeat(model, brief) {
  const id = normalizeId(model);
  return Boolean(id && seatModelsFor(brief)?.includes(id));
}

export function reviewKind(kind) {
  return kind === "crr" || kind === "mrr" ? kind : null;
}

export function isMrrSeatReview(review) {
  return reviewKind(review?.kind) === "mrr" && REVIEW_ROLES.includes(review?.role);
}

export function seatingFor(role, model = null, route = null) {
  if (role === CRR_ROLE) {
    const selected = String(model || "local").trim();
    if (!selected) throw new Error("crr requires a model id");
    return { role: CRR_ROLE, intended: selected, model: selected, route: route || "cli" };
  }
  const entries = seatFor(role).models;
  const seatModels = entries.map((entry) => entry.id);
  const selected = model ? normalizeId(model) : seatModels[0];
  if (!seatModels.includes(selected)) {
    throw new Error(`${model} is not a valid ${role} model (valid: ${seatModels.join(", ")}). Add it to seats.${role}.models in ${configSource()} to use it.`);
  }
  const entry = entries.find((item) => item.id === selected);
  const resolvedRoute = route || (entry?.launch === "native" ? "native" : "cli");
  return { role, intended: seatModels[0], seatModels, model: selected, launch: entry?.launch, cliModel: entry?.cliModel || selected, route: resolvedRoute };
}

export function validateReview(input, brief) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review envelope must be an object");
  if (input.reviewComplete !== true || input.independent !== true) throw new Error("Review requires reviewComplete=true and independent=true");
  if (!["GO", "NO_GO"].includes(input.verdict)) throw new Error("Review verdict must be GO or NO_GO");
  const kind = reviewKind(input.kind);
  const role = input.role;
  if (!kind) throw new Error("Review kind must be crr or mrr");
  if (kind === "crr" && role !== CRR_ROLE) throw new Error("CRR must use role crr");
  if (kind === "mrr" && (!REVIEW_ROLES.includes(role) || (brief && role !== brief.role))) throw new Error("MRR must identify its exact review role");
  if (!UUID.test(input.runId || "") || (brief && input.runId !== brief.id)) throw new Error("Review must reference its exact Field Report runId");
  if (!String(input.branch || "").trim() || (brief && input.branch !== brief.branch)) throw new Error("Review branch must match its exact Field Report brief");
  if (!SHA.test(input.head || "") || !SHA.test(input.baseHead || "")) throw new Error("Review requires exact head and baseHead SHAs");
  if (kind === "crr" && brief?.tree && !SHA.test(input.tree || "")) throw new Error("Staged CRR requires the exact staged tree SHA");
  if (kind === "mrr" && input.tree != null) throw new Error("MRR must not include a staged tree");
  if (brief && (reviewKind(brief.kind) !== kind || brief.head !== input.head || brief.baseHead !== input.baseHead || (kind === "crr" && brief.tree && brief.tree !== input.tree))) {
    throw new Error("Review target does not match its brief");
  }

  let seatModels = null;
  let normalizedModel = String(input.model || "").trim();
  if (!normalizedModel) throw new Error("Review requires a model id");
  if (kind === "mrr") {
    normalizedModel = normalizeId(normalizedModel);
    if (!normalizedModel) throw new Error("Review requires a valid normalized model id");
    if (brief?.model && normalizeId(brief.model) !== normalizedModel) throw new Error("Review model must match its brief");
    if (brief && !fitsSeat(normalizedModel, brief)) throw new Error(`${role} review model ${normalizedModel} is not on its seat's valid list`);
    seatModels = brief ? [...seatModelsFor(brief)] : null;
  }
  if (!["native", "cli"].includes(input.route) || (brief && input.route !== brief.route)) throw new Error("Review route must match its brief");
  if (!Array.isArray(input.findings) || !input.findings.every((item) => typeof item === "string" && item.trim())) throw new Error("Review findings must be a nonblank string array");
  if (input.unresolved != null && (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review unresolved must be a nonblank string array");
  const unresolved = Array.isArray(input.unresolved) ? input.unresolved : [];
  if (input.questions != null && (!Array.isArray(input.questions) || !input.questions.every((item) => typeof item === "string" && item.trim()))) throw new Error("Review questions must be a nonblank string array");
  if (input.verdict === "NO_GO" && !(input.findings.length || unresolved.length)) throw new Error("NO_GO requires at least one finding or unresolved item");
  if (input.verdict === "GO" && (input.findings.length || unresolved.length)) throw new Error("GO cannot carry findings or unresolved items");
  if (!String(input.summary || "").trim()) throw new Error("Review requires a summary");
  for (const key of SCORE_KEYS) assertScore(input.scores?.[key], key);
  for (const key of SCORE_KEYS) if (!String(input.scoreRationale?.[key] || "").trim()) throw new Error(`${key} requires explanatory rationale`);
  if (kind === "mrr") {
    for (const [key, values] of Object.entries(SIGNAL_VALUES)) if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(", ")}`);
    if (!String(input.simplerPath || "").trim()) throw new Error("simplerPath must explain alternatives considered and discarded, or state that none were found");
    if (role === "intent" && !String(input.intentSummary || "").trim()) throw new Error("intent seat review requires a nonblank intentSummary playback");
  }

  return {
    runId: input.runId,
    reviewerId: String(input.reviewerId || `${input.route}:${normalizedModel}:${input.runId.slice(0, 8)}`),
    kind,
    role,
    branch: input.branch,
    head: input.head,
    baseHead: input.baseHead,
    ...(kind === "crr" && input.tree ? { tree: input.tree } : {}),
    model: normalizedModel,
    route: input.route,
    reviewComplete: true,
    independent: true,
    verdict: input.verdict,
    findings: [...input.findings],
    unresolved,
    ...(input.questions?.length ? { questions: [...input.questions] } : {}),
    summary: input.summary.trim(),
    ...(input.intentSummary ? { intentSummary: input.intentSummary.trim() } : {}),
    scores: { ...input.scores },
    scoreRationale: { ...input.scoreRationale },
    ...(kind === "mrr"
      ? {
          necessity: input.necessity,
          scopeDrift: input.scopeDrift,
          contractIntegrity: input.contractIntegrity,
          evidenceQuality: input.evidenceQuality,
          simplerPath: input.simplerPath.trim(),
          ...(seatModels ? { seatModels } : {})
        }
      : {})
  };
}

// Sequential F-ids across the branch's recorded MRR reviews.
export function findingLedger(reviews) {
  const entries = [];
  let counter = 0;
  for (const review of reviews || []) {
    if (!isMrrSeatReview(review)) continue;
    for (const [category, items] of [["finding", review.findings], ["unresolved", review.unresolved]]) {
      for (const text of items || []) {
        counter += 1;
        entries.push({ id: `F${counter}`, category, text, role: review.role, head: review.head, runId: review.runId });
      }
    }
  }
  return entries;
}

const short = (sha) => String(sha || "").slice(0, 12);

// Each seat is decided by its reviewed commit nearest HEAD among HEAD and its
// ancestors. Earlier GOs carry forward; NO_GOs block until fixed on a new head
// and rerun for that seat, or accepted by the user.
export function seatStatus(reviews, role, { target, ancestors = null, dispositions = [], ledger = findingLedger(reviews) }) {
  const heads = ancestors || new Map([[target.head, 0]]);
  const mine = (reviews || []).filter((review) => isMrrSeatReview(review) && review.role === role && review.branch === target.branch && heads.has(review.head));
  if (!mine.length) return { role, state: "missing", open: [], accepted: [] };
  const head = mine.reduce((best, review) => (heads.get(review.head) < heads.get(best) ? review.head : best), mine[0].head);
  const onHead = mine.filter((review) => review.head === head);
  const acceptance = new Map(dispositions.map((item) => [item.findingId, item]));
  const open = [];
  const accepted = [];
  for (const review of onHead.filter((item) => item.verdict === "NO_GO")) {
    for (const finding of ledger.filter((item) => item.runId === review.runId)) {
      if (acceptance.has(finding.id)) accepted.push({ ...finding, disposition: acceptance.get(finding.id) });
      else open.push(finding);
    }
  }
  const behind = heads.get(head) || 0;
  return { role, state: open.length ? "blocked" : "satisfied", head, behind, carried: head !== target.head, review: onHead[onHead.length - 1], open, accepted };
}

// One review per seat per exact head: prevents shopping for a GO on identical code.
export function assertSeatOpen(reviews, { role, target }) {
  const done = (reviews || []).find((review) => isMrrSeatReview(review) && review.role === role && review.branch === target.branch && review.head === target.head);
  if (!done) return;
  const accept = done.verdict === "NO_GO" ? ", or record the user's acceptance of its findings with fr accept <F-id> --reason <text>" : "";
  throw new Error(`${role} already reviewed head ${short(target.head)} (${done.verdict}); fix on a new commit to rerun it${accept}`);
}

export function evaluateMrrGate({ target, reviews, dispositions = [], ancestors = null }) {
  const ledger = findingLedger(reviews);
  const seats = Object.fromEntries(REVIEW_ROLES.map((role) => [role, seatStatus(reviews, role, { target, ancestors, dispositions, ledger })]));
  const reasons = [];
  const notes = [];
  const questions = [];
  for (const seat of Object.values(seats)) {
    const open = seat.open.map((finding) => `${finding.id}: ${finding.text}`).join(" | ");
    if (seat.state === "missing") reasons.push(`missing ${seat.role} review`);
    else if (seat.state === "blocked" && seat.carried) reasons.push(`${seat.role} NO_GO at ${short(seat.head)}; rerun fr mrr --seat ${seat.role} after fixing: ${open}`);
    else if (seat.state === "blocked") reasons.push(`${seat.role} NO_GO on ${short(target.head)}; fix on a new commit and run fr mrr --seat ${seat.role}, or record user acceptance (fr accept): ${open}`);
    else {
      if (seat.carried) notes.push(`${seat.role}: ${seat.review.verdict} at ${short(seat.head)} carried (${seat.behind} unreviewed commit${seat.behind === 1 ? "" : "s"}: ${short(seat.head)}..${short(target.head)})`);
      for (const finding of seat.accepted) notes.push(`${seat.role} ${finding.id} accepted by ${finding.disposition.actor}: ${finding.disposition.reason}`);
    }
    for (const question of seat.review?.questions || []) {
      questions.push({ role: seat.role, question });
      notes.push(`${seat.role} asks the user: ${question}`);
    }
  }
  const lanes = Object.fromEntries(REVIEW_ROLES.map((role) => [role, seats[role].review || null]));
  const latestIntent = [...(reviews || [])].reverse().find((review) => isMrrSeatReview(review) && review.role === "intent" && review.intentSummary);
  return {
    ready: reasons.length === 0,
    kind: "mrr",
    target,
    reasons,
    notes,
    questions,
    lanes,
    seats,
    ledger,
    intentSummary: lanes.intent?.intentSummary || latestIntent?.intentSummary || null
  };
}

export function openReasons({ checkout, target } = {}) {
  const reasons = [];
  if (checkout?.dirty) reasons.push("checkout has uncommitted changes");
  if (target?.head && checkout?.head !== target.head) {
    reasons.push(`checkout HEAD ${short(checkout?.head)} does not match reviewed head ${short(target.head)}`);
  }
  return reasons;
}

export const NO_GITHUB_CHECKS_REASON = "No GitHub checks observed; this is not evidence that CI ran";

function threadLabel(thread) {
  const title = String(thread.body || "").replace(/<[^>]*>|!\[[^\]]*\]\([^)]*\)|[*_`#]/g, "").split("\n").map((line) => line.trim()).find(Boolean) || "";
  return `${thread.path}${thread.line ? `:${thread.line}` : ""} (${thread.author}) ${title.slice(0, 80)}`.trim();
}

export function botsReasons({ project, target, checkout, pr }) {
  const reasons = openReasons({ checkout, target });
  if (!pr) {
    reasons.push("no open pull request");
    return reasons;
  }
  if (pr.state !== "OPEN") reasons.push(`PR #${pr.number} is not open`);
  if (pr.isDraft) reasons.push(`PR #${pr.number} is still a draft`);
  if (pr.headRefOid !== target.head) reasons.push(`PR head ${short(pr.headRefOid)} does not match checkout HEAD ${short(target.head)}`);
  if (pr.headRefName !== target.branch) reasons.push(`PR head branch ${pr.headRefName} does not match ${target.branch}`);
  if (pr.baseRefName !== (project.baseBranch || "main")) reasons.push(`PR base ${pr.baseRefName} does not match configured base ${project.baseBranch || "main"}`);

  const accepted = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const checks = pr.statusCheckRollup || [];
  if (!checks.length) reasons.push(NO_GITHUB_CHECKS_REASON);
  if (checks.some((check) => check.conclusion && !accepted.has(check.conclusion))) reasons.push("GitHub checks include an unsuccessful conclusion");
  if (checks.some((check) => !check.conclusion && !accepted.has(check.state))) reasons.push("GitHub checks are incomplete or unsuccessful");

  if (!Array.isArray(pr.reviewThreads)) {
    reasons.push("review threads were not checked");
    return reasons;
  }
  const open = pr.reviewThreads.filter((thread) => !thread.resolved);
  const botOpen = open.filter((thread) => thread.openerType === "Bot");
  const humanAwaiting = open.filter((thread) => thread.openerType !== "Bot" && thread.viewerRepliedLast);
  const humanNeedsAction = open.filter((thread) => thread.openerType !== "Bot" && !thread.viewerRepliedLast);

  if (botOpen.length) {
    reasons.push(`${botOpen.length} unresolved bot thread${botOpen.length === 1 ? "" : "s"} (fix in code and resolve silently; post a short reply ONLY if declining): ${botOpen.map(threadLabel).join(" | ")}`);
  }
  if (humanNeedsAction.length) {
    reasons.push(`${humanNeedsAction.length} unresolved human thread${humanNeedsAction.length === 1 ? "" : "s"} (fix or reply once concisely, then leave for the reviewer to resolve): ${humanNeedsAction.map(threadLabel).join(" | ")}`);
  }
  if (humanAwaiting.length) {
    reasons.push(`${humanAwaiting.length} human thread${humanAwaiting.length === 1 ? "" : "s"} awaiting human resolution (already replied — do NOT comment again): ${humanAwaiting.map(threadLabel).join(" | ")}`);
  }
  return reasons;
}

export function readyLabel(gate) {
  if (!gate.ready) return "BLOCKED";
  const carried = Object.values(gate.seats || {}).filter((seat) => seat.carried).map((seat) => seat.role);
  return carried.length ? `READY (carried; not reviewed on this HEAD by: ${carried.join(", ")})` : "READY on this HEAD";
}

export function renderFieldReportMarkdown({ project, branch, pr = null, target, gate }) {
  const lines = [
    `# Field Report: ${project.label || project.id} · \`${branch}\``,
    "",
    `- **Project:** \`${project.id}\``,
    `- **Branch:** \`${branch}\`${pr ? ` (PR #${pr.number}${pr.isDraft ? " · Draft" : ""})` : ""}`,
    `- **Target:** \`${short(target.baseHead)}..${short(target.head)}\``,
    `- **MRR Gate:** **${readyLabel(gate)}**`,
    `- **Updated:** ${new Date().toISOString()}`,
    ""
  ];

  lines.push("## Intent Playback", "");
  lines.push(gate.intentSummary || "_Intent seat has not run yet._", "");

  if (gate.questions?.length) {
    lines.push("## Questions for You", "");
    for (const item of gate.questions) lines.push(`- **${item.role}:** ${item.question}`);
    lines.push("");
  }

  lines.push("## Seat Verdicts & Scores", "");
  for (const role of REVIEW_ROLES) {
    const seat = gate.seats?.[role];
    const review = seat?.review;
    if (!review) {
      lines.push(`### ${role}: _missing_`, "");
      continue;
    }
    const delta = seat.carried ? ` _(carried from \`${short(review.head)}\`, ${seat.behind} commit${seat.behind === 1 ? "" : "s"} behind)_` : ` _(\`${short(review.head)}\`)_`;
    lines.push(`### ${role}: **${review.verdict}** via \`${review.model}\`${delta}`);
    lines.push(`- **Scores:** readiness ${review.scores.mergeReadiness}% · structural risk ${review.scores.structuralRisk}% · implementation quality ${review.scores.implementationQuality}% · evidence ${review.scores.evidenceConfidence}% · outcome ${review.scores.outcomeConfidence}%`);
    lines.push(`- **Signals:** necessity \`${review.necessity}\` · scope drift \`${review.scopeDrift}\` · contract \`${review.contractIntegrity}\` · evidence \`${review.evidenceQuality}\``);
    lines.push(`- **Summary:** ${review.summary}`);
    lines.push(`- **Simpler path:** ${review.simplerPath}`);
    for (const finding of seat.open || []) lines.push(`- **Open finding (${finding.id}):** ${finding.text}`);
    for (const finding of seat.accepted || []) lines.push(`- **Accepted (${finding.id} by ${finding.disposition.actor}):** ${finding.text} — _${finding.disposition.reason}_`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

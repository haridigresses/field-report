function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParse(text) {
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function unfence(text) {
  const match = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : "";
}

function parseObject(text) {
  const trimmed = String(text ?? "").trim();
  const value = tryParse(trimmed) ?? tryParse(unfence(trimmed));
  if (isObject(value)) return value;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const nested = tryParse(trimmed.slice(start, end + 1));
    if (isObject(nested)) return nested;
  }
  return undefined;
}

function successfulClaudeResult(value) {
  if (!isObject(value) || value.is_error !== false || value.subtype !== "success") return undefined;
  if (typeof value.result === "string") return String(value.result).trim() ? parseObject(value.result) : undefined;
  return isObject(value.result) ? value.result : undefined;
}

function successfulCursorResult(value) {
  if (!isObject(value) || value.type !== "result") return undefined;
  if (value.is_error !== false || value.subtype !== "success") return undefined;
  if (typeof value.result === "string") return String(value.result).trim() ? parseObject(value.result) : undefined;
  if (isObject(value.result) && value.result.reviewComplete != null) return value.result;
  return undefined;
}

function cursorStreamResult(text) {
  let last;
  for (const line of String(text).split(/\n/)) {
    const value = tryParse(line.trim());
    if (isObject(value) && value.type === "result") last = value;
  }
  return last;
}

function stringList(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === "string") return item.trim();
    if (isObject(item)) return String(item.text || item.finding || item.summary || "").trim();
    return "";
  }).filter(Boolean);
}

export function parseEnvelope(text) {
  const value = parseObject(text) || cursorStreamResult(text);
  if (!value) throw new Error("Review file must contain a JSON object");
  return successfulClaudeResult(value) || successfulCursorResult(value) || value;
}

export function normalizeReview(input, delegation) {
  if (!isObject(input) || !delegation) return input;
  const next = { ...input };
  next.reviewComplete = next.reviewComplete === true;
  next.independent = next.independent === true;
  next.delegationId = delegation.id;
  next.kind = delegation.kind;
  next.role = delegation.role;
  next.claim = delegation.claim;
  next.head = delegation.head;
  next.baseHead = delegation.baseHead;
  next.model = delegation.model;
  next.route = delegation.route;
  delete next.intendedModel;
  if (delegation.intendedModel != null) next.intendedModel = delegation.intendedModel;
  delete next.substitutionReason;
  if (delegation.substitutionReason) next.substitutionReason = delegation.substitutionReason;
  delete next.reconciliationOnly;
  delete next.jobRole;
  delete next.legacy;
  delete next.staleAtRecord;
  if (delegation.reconciliationOnly === true) next.reconciliationOnly = true;
  if (delegation.jobRole) next.jobRole = delegation.jobRole;
  if (next.kind === "crr") next.tree = delegation.tree;
  else delete next.tree;
  next.findings = stringList(next.findings);
  next.unresolved = stringList(next.unresolved);
  if (next.reconciled != null) {
    next.reconciled = (Array.isArray(next.reconciled) ? next.reconciled : []).map((entry) => {
      if (!isObject(entry)) return entry;
      const findingId = String(entry.findingId || entry.id || "").trim();
      return { ...entry, findingId };
    });
  }
  return next;
}

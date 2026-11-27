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

// agy --output-format json: {"status":"SUCCESS","response":"<reply text>"}.
function successfulAgyResult(value) {
  if (!isObject(value) || value.status !== "SUCCESS" || typeof value.response !== "string") return undefined;
  return value.response.trim() ? parseObject(value.response) : undefined;
}

function cursorStreamResult(text) {
  let last;
  for (const line of String(text).split(/\n/)) {
    const value = tryParse(line.trim());
    if (isObject(value) && value.type === "result") last = value;
  }
  return last;
}

function stringList(value, field) {
  if (!Array.isArray(value)) throw new Error(`Review ${field} must be an array`);
  return value.map((item) => {
    if (typeof item === "string" && item.trim()) return item;
    if (isObject(item)) {
      const keys = Object.keys(item);
      if (keys.length === 1 && ["text", "finding", "summary"].includes(keys[0]) && typeof item[keys[0]] === "string" && item[keys[0]].trim()) return item[keys[0]];
    }
    throw new Error(`Review ${field} items must be nonblank strings or single-field text objects`);
  });
}

export function parseEnvelope(text) {
  const value = parseObject(text) || cursorStreamResult(text);
  if (!value) throw new Error("Review file must contain a JSON object");
  return successfulClaudeResult(value) || successfulCursorResult(value) || successfulAgyResult(value) || value;
}

export function normalizeReview(input, delegation, binding) {
  if (!isObject(input) || !delegation) return input;
  const next = { ...input };
  const identity = {
    delegationId: delegation.id,
    kind: delegation.kind,
    role: delegation.role,
    claim: delegation.claim,
    head: delegation.head,
    baseHead: delegation.baseHead,
    model: delegation.model,
    route: delegation.route,
    ...(delegation.kind === "crr" ? { tree: delegation.tree } : {}),
    ...(binding?.taskId ? { reviewerTaskId: binding.taskId } : {})
  };
  for (const [key, value] of Object.entries(identity)) {
    if (Object.hasOwn(next, key) && next[key] !== value) throw new Error(`Review ${key} conflicts with its delegation binding`);
    next[key] = value;
  }
  delete next.legacy;
  if (Object.hasOwn(next, "findings")) next.findings = stringList(next.findings, "findings");
  if (Object.hasOwn(next, "unresolved")) next.unresolved = stringList(next.unresolved, "unresolved");
  if (Object.hasOwn(next, "questions")) next.questions = stringList(next.questions, "questions");
  return next;
}

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
  return isObject(value) ? value : undefined;
}

function successfulClaudeAwsResult(value) {
  if (!isObject(value) || value.is_error !== false || value.subtype !== "success") return undefined;
  if (typeof value.result === "string") return String(value.result).trim() ? parseObject(value.result) : undefined;
  return isObject(value.result) ? value.result : undefined;
}

export function parseEnvelope(text) {
  const value = parseObject(text);
  if (!value) throw new Error("Review file must contain a JSON object");
  return successfulClaudeAwsResult(value) || value;
}

export function classifyPullRequests(prs, branch) {
  const open = prs.filter((pr) => pr.state === "OPEN");
  const newest = (items) => [...items].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0) || right.number - left.number)[0] || null;
  const current = newest(open.filter((pr) => !branch || pr.headRefName === branch)) || newest(open);
  const openBranches = new Set(open.map((pr) => pr.headRefName).filter(Boolean));
  const weight = { current: 0, active: 1, superseded: 2, past: 3 };
  return prs.map((pr) => ({
    ...pr,
    current: pr.number === current?.number,
    relation: pr.number === current?.number ? "current" : pr.state === "OPEN" ? "active" : openBranches.has(pr.headRefName) ? "superseded" : "past"
  })).sort((left, right) => weight[left.relation] - weight[right.relation] || new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
}

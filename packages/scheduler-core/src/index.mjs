// Pure DAG, stable ordering and path overlap, adapted from the previous planner.
export function dependencyCycle(nodes) {
  const edges = new Map(nodes.map((n) => [n.key ?? n.id, n.deps ?? []]));
  const visiting = new Set(),
    visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const d of edges.get(id) ?? []) if (visit(d)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...edges.keys()].some(visit);
}
export function dependenciesReady(task, byId) {
  return task.deps.every((id) =>
    ["VERIFIED", "DONE"].includes(byId.get(id)?.status),
  );
}
export function orderedTasks(tasks) {
  return [...tasks].sort(
    (a, b) =>
      a.priority - b.priority ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
export function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

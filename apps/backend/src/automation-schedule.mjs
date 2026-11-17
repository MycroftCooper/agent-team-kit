// All timestamps are absolute instants. Interval schedules use elapsed time,
// rather than calendar arithmetic, so machine time-zone changes do not move them.
export function occurrencesBetween(schedule, after, until) {
  if (until <= after) return { count: 0, latest: null };
  if (schedule.type === "at") {
    const due = schedule.times.map(Date.parse).filter(time => time > after && time <= until);
    return { count: due.length, latest: due.length ? Math.max(...due) : null };
  }
  const start = Date.parse(schedule.startAt), interval = schedule.everySeconds * 1000;
  const first = Math.max(0, Math.floor((after - start) / interval) + 1);
  const last = Math.min((schedule.count ?? Infinity) - 1, Math.floor((until - start) / interval));
  return last < first ? { count: 0, latest: null } : { count: last - first + 1, latest: start + last * interval };
}

export function nextOccurrence(schedule, after) {
  if (schedule.type === "at") return schedule.times.map(Date.parse).filter(time => time > after).sort((a, b) => a - b)[0] ?? null;
  const start = Date.parse(schedule.startAt), interval = schedule.everySeconds * 1000;
  const index = Math.max(0, Math.floor((after - start) / interval) + 1);
  const next = start + index * interval;
  return index >= (schedule.count ?? Infinity) || next > 8640000000000000 ? null : next;
}

export const scheduleGraceMs = 30000;

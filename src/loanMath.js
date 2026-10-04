const DAY_MS = 86400000;

export function daysBetween(startDate, endDate) {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

export function loanSummary(record) {
  const elapsedDays = daysBetween(record.lentDate, record.dueDate);
  const interval = Number(record.interestIntervalDays);
  const recurring = Number.isSafeInteger(interval) && interval > 0;
  const cycles = recurring ? Math.floor(elapsedDays / interval) : null;
  const accruedInterest = recurring ? Math.round(record.interest * cycles) : record.interest;
  return { elapsedDays, cycles, accruedInterest, total: record.principal + accruedInterest };
}

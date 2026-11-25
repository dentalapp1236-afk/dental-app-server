export function clinicAvailabilityForDate(owner, dateStr) {
  const scheduled = (owner?.scheduledAvailability || [])
    .filter((entry) => entry?.effectiveDate && entry.effectiveDate <= dateStr)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return scheduled[0]?.availability?.length ? scheduled[0].availability : (owner?.availability || []);
}

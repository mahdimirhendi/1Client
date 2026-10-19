/** "just now", "5 min ago", "3 h ago", then the date ("Mar 9", with the year when it isn't this year). */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = (now - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year });
}

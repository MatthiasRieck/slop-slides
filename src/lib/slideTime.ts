/**
 * The seconds a typed time stands for: `1:30`, or minutes (`2`, `1.5`). Empty is none, 0; null
 * when it is no time at all.
 */
export function parseTime(text: string): number | null {
  const typed = text.trim();
  if (!typed) return 0;
  const clock = /^(\d+):([0-5]\d)$/.exec(typed);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (!/^\d*\.?\d+$/.test(typed)) return null;
  return Math.round(Number(typed) * 60);
}

/**
 * The path of a waveform: `peaks` (each 0 to 1), one bar each, a unit apart and mirrored around
 * the middle of a box two units tall.
 */
export function wavePath(peaks: number[]): string {
  return peaks.map((peak, i) => `M${i} ${1 - peak}V${1 + peak}`).join("");
}

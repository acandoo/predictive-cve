/**
 * Divide two numbers, treating a zero denominator as an empty result.
 *
 * @param numerator The value to divide.
 * @param denominator The divisor.
 * @returns The quotient, or `0` when the denominator is zero.
 */

export function normalizedDivide(numerator: number, denominator: number) {
  return denominator !== 0 ? numerator / denominator : 0
} /**
 * Calculate normalized timestamp variation, returning zero for fewer than two
 * timestamps.
 *
 * @param instants Timestamps assumed to be ordered chronologically so adjacent
 * values represent consecutive events.
 * @returns The coefficient of variation of adjacent intervals, or `0` when
 * fewer than two timestamps are supplied.
 */
export function normalizedCovBetweenInstants(instants: Temporal.Instant[]) {
  if (instants.length < 2) return 0
  return covBetweenInstants(instants)
}
/**
 * Calculate the coefficient of variation of adjacent timestamp intervals.
 *
 * @param instants At least two timestamps, preferably ordered chronologically.
 * @returns Standard deviation of adjacent interval lengths divided by their
 * mean.
 * @remarks Absolute differences prevent negative intervals, but meaningful
 * inter-commit and inter-tag metrics still assume chronological input.
 */
export function covBetweenInstants(instants: Temporal.Instant[]) {
  const durationsMillis = instants
    .slice(1)
    .map((instant, i) => instant.since(instants[i]).abs().total('milliseconds'))
  const mean =
    durationsMillis.reduce((total, d) => total + d, 0) / durationsMillis.length
  const variance =
    durationsMillis.reduce((total, d) => total + Math.pow(d - mean, 2), 0) /
    durationsMillis.length
  return mean ? Math.sqrt(variance) / mean : 0
} /**
 * Test whether a timestamp lies in a trailing time window.
 *
 * @param date The timestamp to test.
 * @param end The inclusive end of the window.
 * @param duration The length of the window.
 * @returns `true` when the timestamp is after `end - duration` and at or
 * before `end`.
 */

export function isInPeriod(
  date: Temporal.Instant,
  end: Temporal.Instant,
  duration: Temporal.Duration
): boolean {
  const start = end.subtract(duration)
  return (
    Temporal.Instant.compare(date, start) > 0 &&
    Temporal.Instant.compare(date, end) <= 0
  )
}

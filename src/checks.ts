/**
 * Validation shared by the connection, the pool and bulk copy.
 */

/** @internal */
export const MAX_INT32 = 2_147_483_647;

/**
 * Reject a numeric option that is not an integer in range. These values end
 * up in timers (which treat anything past 2^31-1 ms as 1 ms), in C ints, or in
 * pool arithmetic where `NaN` makes every comparison false and the pool never
 * opens a connection — each a silent malfunction, so a bad value fails here.
 *
 * @internal
 */
export const checkInteger = (
  name: string,
  value: number | undefined,
  min: number,
  max: number,
  message = `${name} must be an integer between ${min} and ${max}`
): void => {
  if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) {
    throw new RangeError(`${message}, got ${String(value)}`);
  }
};

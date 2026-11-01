/** A NodeList as an array. Typed loosely because the DOM typings differ between the package and the root program. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const domList = (n: unknown): any[] => Array.prototype.slice.call(n ?? []);

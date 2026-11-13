/**
 * `compute`, remembering its last answer: asked again about the very same values (compared with
 * `Object.is`), it gives that answer without computing. For what a store selector derives, which
 * is asked on every update of the store and seldom about anything new.
 */
export function memoizeLast<Args extends readonly unknown[], Result>(
  compute: (...args: Args) => Result,
): (...args: Args) => Result {
  let last: { args: Args; result: Result } | null = null;
  return (...args) => {
    if (last && last.args.length === args.length && last.args.every((arg, i) => Object.is(arg, args[i]))) {
      return last.result;
    }
    const result = compute(...args);
    last = { args, result };
    return result;
  };
}

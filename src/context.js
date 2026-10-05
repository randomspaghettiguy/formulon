// The evaluation context of the formula being evaluated right now: clock, record history and host
// hooks. Evaluation is synchronous, so a module-level slot is safe and keeps function signatures
// free of plumbing.

const DEFAULT = { now: null, isNew: false, isClone: false, context: {} };
let current = DEFAULT;

export const getContext = () => {
  if (!current.now) return { ...current, now: new Date() };
  return current;
};

export const withContext = (ctx, fn) => {
  const previous = current;
  current = ctx;
  try {
    return fn();
  } finally {
    current = previous;
  }
};

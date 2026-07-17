export function additionalGoodNeeded(good, total, target = 0.8) {
  if (!Number.isInteger(good) || good < 0) throw new Error("good must be a non-negative integer");
  if (!Number.isInteger(total) || total < 0 || good > total) throw new Error("total must contain good outcomes");
  if (!(target >= 0 && target < 1)) throw new Error("target must be in [0, 1)");
  let additional = 0;
  while ((good + additional) / (total + additional || 1) <= target) additional += 1;
  return additional;
}

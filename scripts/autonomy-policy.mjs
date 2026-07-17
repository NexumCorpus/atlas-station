export const AUTONOMY_DISCOVERY_INTERVAL = 4;
export const AUTONOMY_BREATHER_MS = 4000;
export const AUTONOMY_BREATHER_MAX = 300000;

export function followAutonomyTurn({ rested, idleStreak }) {
  if (!rested) {
    return { idleStreak: 0, discovery: false, delay: AUTONOMY_BREATHER_MS };
  }

  const nextIdleStreak = idleStreak + 1;
  const discovery = nextIdleStreak % AUTONOMY_DISCOVERY_INTERVAL === 0;
  const delay = discovery
    ? AUTONOMY_BREATHER_MS
    : Math.min(AUTONOMY_BREATHER_MAX, AUTONOMY_BREATHER_MS * Math.pow(2, nextIdleStreak));
  return { idleStreak: nextIdleStreak, discovery, delay };
}

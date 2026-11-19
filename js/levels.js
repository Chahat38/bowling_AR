const STORAGE_KEY = 'pindrop_ar_progress_v1';

export async function fetchLevels() {
  const res = await fetch('/data/levels.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Failed to load levels');
  return await res.json();
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { unlockedLevel: 1, stars: {}, muted: false };
    const parsed = JSON.parse(raw);
    return {
      unlockedLevel: Math.max(1, Number(parsed.unlockedLevel) || 1),
      stars: parsed.stars && typeof parsed.stars === 'object' ? parsed.stars : {},
      muted: Boolean(parsed.muted),
    };
  } catch {
    return { unlockedLevel: 1, stars: {}, muted: false };
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Ignore storage limits
  }
}

export function calculateStars(level, ballsUsed) {
  const halfBalls = Math.max(1, Math.floor(level.balls / 2));
  if (ballsUsed <= halfBalls) return 3;
  if (ballsUsed < level.balls) return 2;
  return 1;
}

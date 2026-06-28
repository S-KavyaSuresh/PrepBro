import { apiFetch, withJsonBody } from "./api.js";
import { isAuthenticated, loadAuthSession, loadGuestProfile } from "./auth.js";

const GUEST_STATS_KEY = "prepbro_guest_stats";
const LEGACY_GUEST_STATS_KEYS = ["dyslearn_stats", "mindbloom_stats", "prepbro_stats"];
const ACCOUNT_PROGRESS_KEY = "prepbro_account_progress";

const BASE_GUEST_STATS = {
  points: 0,
  streak: 0,
  quizzesCompleted: 0,
  sessionsCompleted: 0,
  simplifiesUsed: 0,
  gamesPlayed: 0,
  storiesRead: 0,
  totalDaysUsed: 0,
  totalMinutes: 0,
  subjectMinutes: {},
  dailyPoints: {},
  dailyMinutes: {},
  dailyGoalCompletedDays: [],
  shownCelebrations: [],
  lastActive: null,
  badges: [],
};

const BASE_ACCOUNT_PROGRESS = {
  student_id: null,
  points: 0,
  streak: 0,
  study_minutes: 0,
  quizzes_completed: 0,
  daily_points: {},
  daily_minutes: {},
  daily_goal_completed_days: [],
  shown_celebrations: [],
  badges: [],
  updated_at: null,
};

export const BADGE_DEFINITIONS = [
  { id: "First Steps", label: "First Steps", description: "Start your first learning activity.", category: "starter" },
  { id: "One Hour Hero", label: "One Hour Hero", description: "Reach 60 total study minutes.", category: "time" },
  { id: "Quiz Explorer", label: "Quiz Explorer", description: "Complete your first quiz.", category: "quiz" },
  { id: "Consistency Star", label: "Consistency Star", description: "Build a steady study streak.", category: "streak" },
  { id: "PrepBro Pro", label: "PrepBro Pro", description: "Reach a high combined progress score.", category: "pro" },
  { id: "Daily Goal Champion", label: "Daily Goal Champion", description: "Meet your daily study target.", category: "goal" },
  { id: "3-Day Streak", label: "3-Day Streak", description: "Complete your daily target 3 days in a row.", category: "streak" },
  { id: "7-Day Streak", label: "7-Day Streak", description: "Complete your daily target 7 days in a row.", category: "streak" },
  { id: "30 Day Streak", label: "30 Day Streak", description: "Complete your daily target 30 days in a row.", category: "streak" },
  { id: "Focus Master", label: "Focus Master", description: "Finish 5 focused study sessions.", category: "focus" },
  { id: "Schedule Starter", label: "Schedule Starter", description: "Complete your first planned session.", category: "planner" },
  { id: "Breaktime Balanced", label: "Breaktime Balanced", description: "Use healthy study-break balance.", category: "balance" },
  { id: "Subject Explorer", label: "Subject Explorer", description: "Study 3 different subjects.", category: "subjects" },
  { id: "Perfect Week", label: "Perfect Week", description: "Meet your target for 7 completed days.", category: "goal" },
  { id: "Mentor Ready", label: "Mentor Ready", description: "Link your account with a mentor.", category: "mentor" },
];

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function getLast7DayKeys() {
  const keys = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

export function getDayLabel(isoKey) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[new Date(`${isoKey}T12:00:00`).getDay()];
}

function getDailyTargetMinutes(mode, accountUser = null) {
  if (mode === "account") {
    const preferences = accountUser?.preferences_json || loadAuthSession()?.user?.preferences_json || {};
    return Number(preferences.daily_study_target_minutes || 0);
  }
  const guest = loadGuestProfile() || {};
  return Number(guest.daily_study_target_minutes || 0);
}

function consecutiveGoalDays(days) {
  const sorted = [...new Set(days || [])].sort();
  let longest = 0;
  let current = 0;
  let prev = null;
  for (const day of sorted) {
    if (!prev) {
      current = 1;
    } else {
      const prevDate = new Date(`${prev}T00:00:00`);
      prevDate.setDate(prevDate.getDate() + 1);
      current = prevDate.toISOString().slice(0, 10) === day ? current + 1 : 1;
    }
    if (current > longest) longest = current;
    prev = day;
  }
  return longest;
}

export function deriveBadgesFromMetrics({
  points = 0,
  streak = 0,
  studyMinutes = 0,
  quizzesCompleted = 0,
  sessionsCompleted = 0,
  subjectMinutes = {},
  dailyGoalCompletedDays = [],
  mentorLinked = false,
}) {
  const achieved = [];
  if (points > 0 || studyMinutes > 0 || quizzesCompleted > 0 || sessionsCompleted > 0) achieved.push("First Steps");
  if (studyMinutes >= 60) achieved.push("One Hour Hero");
  if (quizzesCompleted >= 1) achieved.push("Quiz Explorer");
  if (streak >= 3) achieved.push("Consistency Star");
  if (points >= 200 || (studyMinutes >= 180 && quizzesCompleted >= 3)) achieved.push("PrepBro Pro");
  if ((dailyGoalCompletedDays || []).length >= 1) achieved.push("Daily Goal Champion");
  if (streak >= 3) achieved.push("3-Day Streak");
  if (streak >= 7) achieved.push("7-Day Streak");
  if (streak >= 30) achieved.push("30 Day Streak");
  if (sessionsCompleted >= 5) achieved.push("Focus Master");
  if (sessionsCompleted >= 1) achieved.push("Schedule Starter");
  if (sessionsCompleted >= 2 && studyMinutes >= 50) achieved.push("Breaktime Balanced");
  if (Object.keys(subjectMinutes || {}).filter((key) => Number(subjectMinutes[key] || 0) > 0).length >= 3) achieved.push("Subject Explorer");
  if ((dailyGoalCompletedDays || []).length >= 7) achieved.push("Perfect Week");
  if (mentorLinked) achieved.push("Mentor Ready");
  return achieved;
}

export function buildBadgeSummary(metrics) {
  const achievedIds = deriveBadgesFromMetrics(metrics);
  return {
    achieved: BADGE_DEFINITIONS.filter((badge) => achievedIds.includes(badge.id)),
    locked: BADGE_DEFINITIONS.filter((badge) => !achievedIds.includes(badge.id)),
  };
}

function emitProgressChanged(detail = {}) {
  window.dispatchEvent(new CustomEvent("prepbro:progress-changed", { detail }));
}

function readLegacyGuestStats() {
  for (const key of LEGACY_GUEST_STATS_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw) return { key, raw };
  }
  return null;
}

function migrateLegacyGuestStats() {
  const existing = localStorage.getItem(GUEST_STATS_KEY);
  const legacy = readLegacyGuestStats();
  if (!legacy) {
    LEGACY_GUEST_STATS_KEYS.forEach((key) => localStorage.removeItem(key));
    return existing;
  }
  if (!existing) localStorage.setItem(GUEST_STATS_KEY, legacy.raw);
  LEGACY_GUEST_STATS_KEYS.forEach((key) => localStorage.removeItem(key));
  return localStorage.getItem(GUEST_STATS_KEY);
}

export function initializeTrackerStorage() {
  migrateLegacyGuestStats();
}

function normalizeGuestStats(stats) {
  const safe = { ...BASE_GUEST_STATS, ...(stats || {}) };
  safe.dailyPoints = safe.dailyPoints || {};
  safe.dailyMinutes = safe.dailyMinutes || {};
  safe.subjectMinutes = safe.subjectMinutes || {};
  safe.dailyGoalCompletedDays = safe.dailyGoalCompletedDays || [];
  safe.shownCelebrations = safe.shownCelebrations || [];
  safe.badges = safe.badges || [];
  return safe;
}

function normalizeAccountProgress(progress) {
  const safe = { ...BASE_ACCOUNT_PROGRESS, ...(progress || {}) };
  safe.daily_points = safe.daily_points || {};
  safe.daily_minutes = safe.daily_minutes || {};
  safe.daily_goal_completed_days = safe.daily_goal_completed_days || [];
  safe.shown_celebrations = safe.shown_celebrations || [];
  safe.badges = safe.badges || [];
  return safe;
}

function maybeCompleteDailyGoal(mode, container, today, totalMinutes, subjectMinutes = {}, mentorLinked = false, sessionsCompleted = 0, quizzesCompleted = 0, points = 0, streak = 0) {
  const dailyTarget = getDailyTargetMinutes(mode);
  if (dailyTarget > 0 && totalMinutes >= dailyTarget && !container.dailyGoalCompletedDays?.includes(today)) {
    container.dailyGoalCompletedDays = [...(container.dailyGoalCompletedDays || []), today];
  }
  container.badges = deriveBadgesFromMetrics({
    points,
    streak,
    studyMinutes: totalMinutes,
    quizzesCompleted,
    sessionsCompleted,
    subjectMinutes,
    dailyGoalCompletedDays: container.dailyGoalCompletedDays,
    mentorLinked,
  });
}

export function loadStats() {
  try {
    const raw = localStorage.getItem(GUEST_STATS_KEY) || migrateLegacyGuestStats();
    if (!raw) return normalizeGuestStats({});
    return normalizeGuestStats(JSON.parse(raw));
  } catch {
    return normalizeGuestStats({});
  }
}

export function saveStats(stats, detail = {}) {
  localStorage.setItem(GUEST_STATS_KEY, JSON.stringify(normalizeGuestStats(stats)));
  LEGACY_GUEST_STATS_KEYS.forEach((key) => localStorage.removeItem(key));
  emitProgressChanged(detail);
}

export function clearGuestStats() {
  localStorage.removeItem(GUEST_STATS_KEY);
  LEGACY_GUEST_STATS_KEYS.forEach((key) => localStorage.removeItem(key));
  emitProgressChanged();
}

export function loadAccountProgress() {
  try {
    const raw = sessionStorage.getItem(ACCOUNT_PROGRESS_KEY);
    return raw ? normalizeAccountProgress(JSON.parse(raw)) : normalizeAccountProgress({});
  } catch {
    return normalizeAccountProgress({});
  }
}

export function saveAccountProgress(progress, detail = {}) {
  sessionStorage.setItem(ACCOUNT_PROGRESS_KEY, JSON.stringify(normalizeAccountProgress(progress)));
  emitProgressChanged(detail);
}

export function clearAccountProgress() {
  sessionStorage.removeItem(ACCOUNT_PROGRESS_KEY);
  emitProgressChanged();
}

function applyGuestDailyActivity(stats) {
  const today = getTodayKey();
  if (!stats.dailyPoints) stats.dailyPoints = {};
  if (!stats.dailyMinutes) stats.dailyMinutes = {};
  if (!stats.subjectMinutes) stats.subjectMinutes = {};
  if (!stats.dailyGoalCompletedDays) stats.dailyGoalCompletedDays = [];
  if (!stats.shownCelebrations) stats.shownCelebrations = [];
  if (stats.lastActive !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    stats.streak = stats.lastActive === yesterdayKey ? (stats.streak || 0) + 1 : 1;
    stats.lastActive = today;
    stats.totalDaysUsed = (stats.totalDaysUsed || 0) + 1;
  }
  return today;
}

function applyAccountDailyActivity(progress) {
  const today = getTodayKey();
  progress.daily_points = progress.daily_points || {};
  progress.daily_minutes = progress.daily_minutes || {};
  progress.daily_goal_completed_days = progress.daily_goal_completed_days || [];
  progress.shown_celebrations = progress.shown_celebrations || [];
  return today;
}

function celebrationNeeded(daysDone = [], shownCelebrations = []) {
  const today = getTodayKey();
  return daysDone.includes(today) && !shownCelebrations.includes(today);
}

function nextGuestStats(type, payload = {}) {
  const stats = normalizeGuestStats(loadStats());
  const today = applyGuestDailyActivity(stats);
  if (type === "points") {
    const pts = payload.amount || 0;
    stats.points += pts;
    stats.dailyPoints[today] = (stats.dailyPoints[today] || 0) + pts;
  }
  if (type === "quiz") {
    stats.quizzesCompleted += 1;
    stats.points += 10;
    stats.dailyPoints[today] = (stats.dailyPoints[today] || 0) + 10;
  }
  if (type === "session_complete") {
    const mins = payload.minutes || 25;
    stats.sessionsCompleted += 1;
    stats.totalMinutes += mins;
    stats.dailyMinutes[today] = (stats.dailyMinutes[today] || 0) + mins;
    if (payload.subject) stats.subjectMinutes[payload.subject] = (stats.subjectMinutes[payload.subject] || 0) + mins;
  }
  if (type === "simplify") {
    stats.simplifiesUsed += 1;
    stats.points += 5;
    stats.dailyPoints[today] = (stats.dailyPoints[today] || 0) + 5;
  }
  if (type === "game") {
    stats.gamesPlayed += 1;
    stats.points += 3;
    stats.dailyPoints[today] = (stats.dailyPoints[today] || 0) + 3;
  }
  if (type === "story") {
    stats.storiesRead += 1;
    stats.points += 2;
    stats.dailyPoints[today] = (stats.dailyPoints[today] || 0) + 2;
  }
  maybeCompleteDailyGoal(
    "guest",
    stats,
    today,
    stats.totalMinutes,
    stats.subjectMinutes,
    false,
    stats.sessionsCompleted,
    stats.quizzesCompleted,
    stats.points,
    stats.streak,
  );
  const shouldCelebrate = celebrationNeeded(stats.dailyGoalCompletedDays, stats.shownCelebrations);
  return { stats, shouldCelebrate };
}

function nextAccountProgress(type, payload = {}) {
  const progress = normalizeAccountProgress(loadAccountProgress());
  const today = applyAccountDailyActivity(progress);
  if (type === "points") {
    progress.points += payload.amount || 0;
    progress.daily_points[today] = (progress.daily_points[today] || 0) + (payload.amount || 0);
  }
  if (type === "quiz") {
    progress.quizzes_completed += 1;
    progress.points += 10;
    progress.daily_points[today] = (progress.daily_points[today] || 0) + 10;
  }
  if (type === "session_complete") {
    const minutes = payload.minutes || 25;
    progress.study_minutes += minutes;
    progress.daily_minutes[today] = (progress.daily_minutes[today] || 0) + minutes;
  }
  if (type === "simplify") {
    progress.points += 5;
    progress.daily_points[today] = (progress.daily_points[today] || 0) + 5;
  }
  if (type === "game") {
    progress.points += 3;
    progress.daily_points[today] = (progress.daily_points[today] || 0) + 3;
  }
  if (type === "story") {
    progress.points += 2;
    progress.daily_points[today] = (progress.daily_points[today] || 0) + 2;
  }
  progress.updated_at = new Date().toISOString();
  if (type !== "points" || (payload.amount || 0) > 0) progress.streak = Math.max(progress.streak || 0, 1);
  const mentorLinked = Boolean(loadAuthSession()?.user?.preferences_json?.teacher_email);
  maybeCompleteDailyGoal(
    "account",
    progress,
    today,
    progress.study_minutes,
    {},
    mentorLinked,
    0,
    progress.quizzes_completed,
    progress.points,
    progress.streak,
  );
  const shouldCelebrate = celebrationNeeded(progress.daily_goal_completed_days, progress.shown_celebrations);
  return { progress, shouldCelebrate };
}

async function pushAccountProgress(progress) {
  if (!loadAuthSession()?.token) return;
  const response = await apiFetch("/progress", withJsonBody("PUT", normalizeAccountProgress(progress)));
  saveAccountProgress(response);
}

export function markGoalCelebrationShown() {
  const today = getTodayKey();
  if (isAuthenticated()) {
    const progress = loadAccountProgress();
    if (!progress.shown_celebrations.includes(today)) {
      progress.shown_celebrations = [...progress.shown_celebrations, today];
      saveAccountProgress(progress, { celebrationShown: true });
      void pushAccountProgress(progress).catch(() => {});
    }
    return;
  }
  const stats = loadStats();
  if (!stats.shownCelebrations.includes(today)) {
    stats.shownCelebrations = [...stats.shownCelebrations, today];
    saveStats(stats, { celebrationShown: true });
  }
}

export function shouldShowDailyGoalCelebration() {
  if (isAuthenticated()) {
    const progress = loadAccountProgress();
    return celebrationNeeded(progress.daily_goal_completed_days || [], progress.shown_celebrations || []);
  }
  const stats = loadStats();
  return celebrationNeeded(stats.dailyGoalCompletedDays || [], stats.shownCelebrations || []);
}

export function recordActivity(type, payload = {}) {
  if (isAuthenticated()) {
    const { progress, shouldCelebrate } = nextAccountProgress(type, payload);
    saveAccountProgress(progress, { shouldCelebrate });
    void pushAccountProgress(progress).catch(() => {});
    return;
  }
  const { stats, shouldCelebrate } = nextGuestStats(type, payload);
  saveStats(stats, { shouldCelebrate });
}

export async function fetchAccountProgress() {
  const progress = await apiFetch("/progress");
  saveAccountProgress(progress);
  return normalizeAccountProgress(progress);
}

export function hasGuestProgress() {
  const stats = loadStats();
  return Boolean(stats.points || stats.totalMinutes || stats.quizzesCompleted || stats.sessionsCompleted);
}

export async function syncGuestProgressToAccount() {
  if (!isAuthenticated()) return null;
  const guestStats = loadStats();
  if (!hasGuestProgress()) return null;
  const accountProgress = loadAccountProgress();
  const mergedDailyPoints = { ...(accountProgress.daily_points || {}) };
  Object.entries(guestStats.dailyPoints || {}).forEach(([key, value]) => {
    mergedDailyPoints[key] = (mergedDailyPoints[key] || 0) + Number(value || 0);
  });
  const mergedDailyMinutes = { ...(accountProgress.daily_minutes || {}) };
  Object.entries(guestStats.dailyMinutes || {}).forEach(([key, value]) => {
    mergedDailyMinutes[key] = (mergedDailyMinutes[key] || 0) + Number(value || 0);
  });
  const merged = normalizeAccountProgress({
    ...accountProgress,
    points: (accountProgress.points || 0) + (guestStats.points || 0),
    streak: Math.max(accountProgress.streak || 0, guestStats.streak || 0),
    study_minutes: (accountProgress.study_minutes || 0) + (guestStats.totalMinutes || 0),
    quizzes_completed: (accountProgress.quizzes_completed || 0) + (guestStats.quizzesCompleted || 0),
    daily_points: mergedDailyPoints,
    daily_minutes: mergedDailyMinutes,
    daily_goal_completed_days: [...new Set([...(accountProgress.daily_goal_completed_days || []), ...(guestStats.dailyGoalCompletedDays || [])])],
    shown_celebrations: [...new Set([...(accountProgress.shown_celebrations || []), ...(guestStats.shownCelebrations || [])])],
  });
  merged.badges = deriveBadgesFromMetrics({
    points: merged.points,
    streak: merged.streak,
    studyMinutes: merged.study_minutes,
    quizzesCompleted: merged.quizzes_completed,
    dailyGoalCompletedDays: merged.daily_goal_completed_days,
    mentorLinked: Boolean(loadAuthSession()?.user?.preferences_json?.teacher_email),
  });
  const saved = await apiFetch("/progress", withJsonBody("PUT", merged));
  saveAccountProgress(saved);
  return saved;
}

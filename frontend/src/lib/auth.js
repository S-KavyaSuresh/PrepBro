const TOKEN_KEY = "prepbro_token";
const USER_KEY = "prepbro_user";
const LEGACY_AUTH_KEY = "prepbro_auth_session";
const GUEST_PROFILE_KEY = "prepbro_guest_profile";
const ACCOUNT_ONLY_LOCAL_KEYS = [
  "prepbro_profile",
  "prepbro_account_progress",
  "prepbro_assignment_due_reminders",
];
const UNUSED_KEYS = [
  "dyslearn_stats",
  "mindbloom_stats",
  "prepbro_stats",
  "puter.app.id",
  "puter.auth.token",
  "mindbloom_auth_session",
  "mindbloom_token",
  "mindbloom_user",
  "dyslearn_token",
  "dyslearn_user",
];

function emitAuthChanged() {
  window.dispatchEvent(new CustomEvent("prepbro:auth-changed"));
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function purgeLegacyBrandingKeys(storage) {
  const keysToRemove = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    if (key.includes("dyslearn") || key.includes("mindbloom") || key.includes("puter.")) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => storage.removeItem(key));
}

function migrateLegacyAuthSession() {
  const sessionLegacy = safeJsonParse(sessionStorage.getItem(LEGACY_AUTH_KEY));
  const localLegacy = safeJsonParse(localStorage.getItem(LEGACY_AUTH_KEY));
  const legacy = sessionLegacy || localLegacy;
  if (!legacy) return;

  if (legacy.token) {
    localStorage.setItem(TOKEN_KEY, legacy.token);
  }
  if (legacy.user || legacy.expires_at) {
    localStorage.setItem(USER_KEY, JSON.stringify({
      user: legacy.user || null,
      expires_at: legacy.expires_at || null,
    }));
  }

  sessionStorage.removeItem(LEGACY_AUTH_KEY);
  localStorage.removeItem(LEGACY_AUTH_KEY);
}

export function initializeAuthStorage() {
  migrateLegacyAuthSession();
  UNUSED_KEYS.forEach((key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
  purgeLegacyBrandingKeys(localStorage);
  purgeLegacyBrandingKeys(sessionStorage);
}

export function getAuthStorageKey() {
  return TOKEN_KEY;
}

export function loadAuthSession() {
  initializeAuthStorage();
  const token = localStorage.getItem(TOKEN_KEY);
  const storedUser = safeJsonParse(localStorage.getItem(USER_KEY));
  if (!token) return null;
  return {
    token,
    user: storedUser?.user || null,
    expires_at: storedUser?.expires_at || null,
  };
}

export function saveAuthSession(session) {
  if (!session?.token) return;
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify({
    user: session.user || null,
    expires_at: session.expires_at || null,
  }));
  sessionStorage.removeItem(LEGACY_AUTH_KEY);
  localStorage.removeItem(LEGACY_AUTH_KEY);
  emitAuthChanged();
}

export function clearAuthSession() {
  initializeAuthStorage();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  ACCOUNT_ONLY_LOCAL_KEYS.forEach((key) => localStorage.removeItem(key));
  sessionStorage.removeItem("prepbro_account_progress");
  sessionStorage.removeItem(LEGACY_AUTH_KEY);

  const localKeysToRemove = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && (key.includes("mindbloom") || key.includes("dyslearn") || key.includes("puter."))) {
      localKeysToRemove.push(key);
    }
  }
  localKeysToRemove.forEach((key) => localStorage.removeItem(key));

  const sessionKeysToRemove = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key && (key.startsWith("prepbro_") || key.includes("mindbloom") || key.includes("dyslearn") || key.includes("puter."))) {
      sessionKeysToRemove.push(key);
    }
  }
  sessionKeysToRemove.forEach((key) => sessionStorage.removeItem(key));
  emitAuthChanged();
}

export function isAuthenticated() {
  const session = loadAuthSession();
  return Boolean(session?.token);
}

export function loadGuestProfile() {
  try {
    const raw = localStorage.getItem(GUEST_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveGuestProfile(profile) {
  localStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new CustomEvent("prepbro:guest-profile-changed"));
}

export function getUserInitials() {
  const session = loadAuthSession();
  const accountName = session?.user?.display_name || session?.user?.email;
  if (accountName) {
    return accountName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  const guest = loadGuestProfile();
  if (guest?.display_name) {
    return guest.display_name.slice(0, 2).toUpperCase();
  }
  return "G";
}

export function getUserDisplayName() {
  const session = loadAuthSession();
  return session?.user?.display_name || session?.user?.email || "Guest";
}

export function getAvatarDataFromUser(user) {
  return user?.preferences_json?.profile_photo_data || "";
}

export function getUserAvatarData() {
  const session = loadAuthSession();
  return getAvatarDataFromUser(session?.user);
}

export function getUserFirstName() {
  const displayName = getUserDisplayName();
  if (displayName === "Guest") return "Guest";
  const first = displayName.includes("@")
    ? displayName.split("@")[0]
    : displayName.trim().split(/\s+/)[0];
  return first || "Guest";
}

export function getUserRole() {
  const session = loadAuthSession();
  return session?.user?.role || "guest";
}

export function getCurrentMode() {
  return isAuthenticated() ? "account" : "guest";
}

import { loadAuthSession } from "./auth.js";

const DEFAULT_BASE = "http://localhost:8000";

export function getApiBase() {
  return import.meta.env.VITE_API_BASE_URL || DEFAULT_BASE;
}

function stringifyValidationDetail(detail) {
  if (Array.isArray(detail)) {
    return detail
      .map((item) => item?.msg || item?.message || "")
      .filter(Boolean)
      .join(". ");
  }
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    return detail.message || detail.error || JSON.stringify(detail);
  }
  return "";
}

export async function apiFetch(path, options = {}) {
  const base = getApiBase();
  const session = loadAuthSession();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (session?.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${session.token}`);
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, { ...options, headers });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Request timed out. Please try again."
      : "Cannot connect to server. Please make sure the backend is running.";
    const err = new Error(message);
    err.status = 0;
    err.cause = error;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    try {
      data = { detail: await res.text() };
    } catch {
      // ignore
    }
  }
  if (!res.ok) {
    let msg = stringifyValidationDetail(data?.detail) || data?.error || data?.message || `Request failed (${res.status})`;
    if (res.status === 422 && path === "/login") {
      msg = "Please enter a valid email and password.";
    }
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function withJsonBody(method, payload, options = {}) {
  return {
    ...options,
    method,
    body: JSON.stringify(payload),
  };
}


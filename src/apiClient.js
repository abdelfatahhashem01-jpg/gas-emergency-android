const API_BASE = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function csrfCookie() {
  const item = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("gas_csrf="));
  return item ? decodeURIComponent(item.slice("gas_csrf=".length)) : "";
}

export async function apiRequest(path, { method = "GET", body, headers = {} } = {}) {
  const requestHeaders = { Accept: "application/json", ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    const csrf = csrfCookie();
    if (csrf) requestHeaders["X-CSRF-Token"] = csrf;
  }

  const response = await fetch(`${API_BASE}/api${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `تعذر الاتصال بالخادم (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const authApi = {
  status: () => apiRequest("/auth/status"),
  setup: (body, setupToken) => apiRequest("/auth/setup", {
    method: "POST",
    body,
    headers: { "X-Initial-Setup-Token": setupToken },
  }),
  login: (loginId, password) => apiRequest("/auth/login", {
    method: "POST",
    body: { loginId, password },
  }),
  me: () => apiRequest("/auth/me"),
  logout: () => apiRequest("/auth/logout", { method: "POST", body: {} }),
  changePassword: (currentPassword, newPassword) => apiRequest("/auth/password", {
    method: "POST",
    body: { currentPassword, newPassword },
  }),
};

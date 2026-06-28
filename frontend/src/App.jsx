import React, { useCallback, useEffect, useMemo, useState } from "react";
import FeatureTabs from "./components/FeatureTabs.jsx";
import SettingsBanner from "./components/SettingsBanner.jsx";
import FloatingSupport from "./components/FloatingSupport.jsx";
import UserAccountPanel from "./components/UserAccountPanel.jsx";
import InstallBanner from "./components/InstallBanner.jsx";

import SimplifyText from "./pages/SimplifyText.jsx";
import GamifiedLearning from "./pages/GamifiedLearning.jsx";
import Breaktime from "./pages/Breaktime.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Planner from "./pages/Planner.jsx";
import InstallApp from "./pages/InstallApp.jsx";
import AccountSettings from "./pages/AccountSettings.jsx";
import AuthPage from "./pages/AuthPage.jsx";

import { apiFetch, getApiBase } from "./lib/api.js";
import { getAvatarDataFromUser, getCurrentMode, getUserFirstName, loadAuthSession, saveAuthSession } from "./lib/auth.js";

const PWA_INSTALLED_KEY = "prepbro_pwa_installed";
const SIGNUP_VERIFY_KEY = "prepbro_verified_signup_email";
const SIGNUP_DRAFT_KEY = "prepbro_signup_draft";

function detectStandaloneInstall() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || window.navigator.standalone === true;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("simplify");
  const [userPanelOpen, setUserPanelOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [mode, setMode] = useState(getCurrentMode());
  const [backendStatus, setBackendStatus] = useState("checking");
  const [toasts, setToasts] = useState([]);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installPromptAvailable, setInstallPromptAvailable] = useState(false);
  const [isInstalled, setIsInstalled] = useState(() => detectStandaloneInstall() || localStorage.getItem(PWA_INSTALLED_KEY) === "true");
  const [authPageMode, setAuthPageMode] = useState("signup");
  const [verificationMessage, setVerificationMessage] = useState("");
  const [accountSettingsDirty, setAccountSettingsDirty] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState(null);
  const accountSettingsHandlers = React.useRef({
    save: async () => {},
    discard: () => {},
  });

  const authSession = useMemo(() => loadAuthSession(), [mode, userPanelOpen]);
  const accountButtonLabel = useMemo(() => getUserFirstName(), [mode, userPanelOpen, authSession?.user?.display_name]);
  const accountAvatar = useMemo(() => getAvatarDataFromUser(authSession?.user), [authSession?.user]);

  const pushToast = useCallback((msg, type = "error") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  const refreshIdentity = useCallback(() => {
    setMode(getCurrentMode());
  }, []);

  const checkBackend = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/health`, { signal: AbortSignal.timeout(4000) });
      setBackendStatus(res.ok ? "ok" : "down");
    } catch {
      setBackendStatus("down");
    }
  }, []);

  useEffect(() => {
    checkBackend();
  }, [checkBackend]);

  useEffect(() => {
    const handler = (event) => pushToast(event.detail.msg, event.detail.type || "error");
    window.addEventListener("mb:toast", handler);
    return () => window.removeEventListener("mb:toast", handler);
  }, [pushToast]);

  useEffect(() => {
    const refresh = () => refreshIdentity();
    window.addEventListener("prepbro:auth-changed", refresh);
    window.addEventListener("prepbro:guest-profile-changed", refresh);
    return () => {
      window.removeEventListener("prepbro:auth-changed", refresh);
      window.removeEventListener("prepbro:guest-profile-changed", refresh);
    };
  }, [refreshIdentity]);

  useEffect(() => {
    if (authSession?.user?.role === "teacher" && ["simplify", "planner", "gamified", "breaktime"].includes(activeTab)) {
      setActiveTab("dashboard");
    }
  }, [authSession?.user?.role, activeTab]);

  useEffect(() => {
    if (activeTab === "classes" && authSession?.user?.role !== "teacher") {
      setActiveTab("dashboard");
    }
    if (activeTab === "assignments" && authSession?.user?.role !== "teacher") {
      setActiveTab("dashboard");
    }
  }, [authSession?.user?.role, activeTab]);

  useEffect(() => {
    if (authSession?.token && activeTab === "auth") {
      setActiveTab("dashboard");
    }
  }, [authSession?.token, activeTab]);

  useEffect(() => {
    const syncInstalledState = () => {
      const standalone = detectStandaloneInstall();
      if (standalone) {
        localStorage.setItem(PWA_INSTALLED_KEY, "true");
        setIsInstalled(true);
        setInstallPromptAvailable(false);
        return;
      }
      if (installPromptAvailable || deferredInstallPrompt) {
        localStorage.removeItem(PWA_INSTALLED_KEY);
        setIsInstalled(false);
        return;
      }
      setIsInstalled(localStorage.getItem(PWA_INSTALLED_KEY) === "true");
    };
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setInstallPromptAvailable(true);
      localStorage.removeItem(PWA_INSTALLED_KEY);
      setIsInstalled(false);
    };
    const handleInstalled = () => {
      setDeferredInstallPrompt(null);
      setInstallPromptAvailable(false);
      setIsInstalled(true);
      localStorage.setItem(PWA_INSTALLED_KEY, "true");
      pushToast("PrepBro was installed successfully.", "success");
    };
    const standaloneMedia = window.matchMedia?.("(display-mode: standalone)");
    syncInstalledState();
    window.addEventListener("visibilitychange", syncInstalledState);
    window.addEventListener("focus", syncInstalledState);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    standaloneMedia?.addEventListener?.("change", syncInstalledState);
    return () => {
      window.removeEventListener("visibilitychange", syncInstalledState);
      window.removeEventListener("focus", syncInstalledState);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      standaloneMedia?.removeEventListener?.("change", syncInstalledState);
    };
  }, [deferredInstallPrompt, installPromptAvailable, pushToast]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get("verify");
    if (!verifyToken) return;
    const runVerification = async () => {
      try {
        const verification = await apiFetch("/verification/verify", {
          method: "POST",
          body: JSON.stringify({ token: verifyToken }),
        });
        if (authSession?.token) {
          const refreshedProfile = await apiFetch("/profile");
          saveAuthSession({ ...authSession, user: refreshedProfile });
          setActiveTab("account-settings");
        } else {
          if (verification?.pending_signup && verification?.email) {
            const verifiedEmail = String(verification.email).trim().toLowerCase();
            localStorage.setItem(SIGNUP_VERIFY_KEY, verifiedEmail);
            if (verification?.draft && typeof verification.draft === "object") {
              localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify({
                ...verification.draft,
                email: verification.draft.email || verifiedEmail,
                parent_guardian_email: verification.draft.parent_guardian_email || "",
              }));
            } else {
              localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify({
                email: verifiedEmail,
                parent_guardian_email: verifiedEmail,
              }));
            }
            setVerificationMessage(`Email verified successfully for ${verifiedEmail}. Please go back and complete the account creation.`);
            setActiveTab("verification-success");
          } else {
            setAuthPageMode("login");
            setActiveTab("auth");
            pushToast("Email verification completed. Log in to open Account Settings.", "success");
          }
        }
        params.delete("verify");
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
        window.history.replaceState({}, "", nextUrl);
      } catch (error) {
        pushToast(error.message || "Verification failed.", "error");
      }
    };
    void runVerification();
  }, [authSession, pushToast]);

  const handleInstallClick = useCallback(async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice?.outcome !== "accepted") {
      setInstallPromptAvailable(true);
      return;
    }
    setDeferredInstallPrompt(null);
    setInstallPromptAvailable(false);
  }, [deferredInstallPrompt]);

  const handleDirtyStateChange = useCallback(({ dirty, save, discard }) => {
    setAccountSettingsDirty(Boolean(dirty));
    accountSettingsHandlers.current = {
      save: save || (async () => {}),
      discard: discard || (() => {}),
    };
  }, []);

  const requestTabChange = useCallback((nextTab) => {
    if (activeTab === "account-settings" && accountSettingsDirty && nextTab !== "account-settings") {
      setUnsavedDialog({ nextTab });
      return;
    }
    setUserPanelOpen(false);
    setActiveTab(nextTab);
  }, [activeTab, accountSettingsDirty]);

  const openInstallPage = useCallback(() => {
    requestTabChange("install");
  }, [requestTabChange]);

  const openAccountSettings = useCallback(() => {
    requestTabChange("account-settings");
  }, [requestTabChange]);

  const openAuthPage = useCallback((nextMode = "signup") => {
    setAuthPageMode(nextMode);
    requestTabChange("auth");
  }, [requestTabChange]);

  const handleLogout = useCallback(() => {
    setUserPanelOpen(false);
    setActiveTab("dashboard");
    refreshIdentity();
  }, [refreshIdentity]);

  return (
    <div className={`app-root ${aiOpen ? "ai-open" : ""}`}>
      <header className="app-header">
        <div className="app-logo">
          <img src="/icons/prepbro-192-final.png?v=prepbro-icon-final" alt="PrepBro app icon" className="logo-icon" />
          <span className="logo-mark">Prep</span>
          <span className="logo-mark-alt">Bro</span>
          <span className="logo-tagline">Study at Your Own Pace</span>
        </div>
        <div className="app-header-right">
          <button
            className="btn-ghost header-install-btn"
            type="button"
            aria-label="Open Install App page"
            onClick={openInstallPage}
          >
            Install App
          </button>
          <button
            id="userAccountButton"
            className="user-avatar user-avatar-label"
            type="button"
            aria-label="User account"
            onClick={() => setUserPanelOpen((value) => !value)}
          >
            {accountAvatar ? (
              <img src={accountAvatar} alt="Profile" className="user-avatar-photo" />
            ) : (
              <span className="user-avatar-initials">{accountButtonLabel}</span>
            )}
          </button>
        </div>
      </header>

      {backendStatus === "down" && (
        <div className="backend-banner">
          <span className="backend-banner-icon">!</span>
          <span className="backend-banner-text">
            <strong>Backend server is not running.</strong> Start the FastAPI app in <code>backend/</code> with <code>uvicorn app.main:app --reload</code>.
          </span>
          <button className="backend-banner-retry" onClick={checkBackend}>Retry</button>
        </div>
      )}
      {backendStatus === "checking" && (
        <div className="backend-banner backend-banner-checking">
          <span>Connecting to backend...</span>
        </div>
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.type}`}>
            <span>{toast.msg}</span>
            <button onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}>x</button>
          </div>
        ))}
      </div>

      <main className="app-main">
        <section className="main-content">
          <FeatureTabs active={activeTab} onChange={requestTabChange} role={authSession?.user?.role || "guest"} />

          <section className="card main-panel">
            <div style={{ display: activeTab === "simplify" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <SimplifyText />
            </div>
            <div style={{ display: activeTab === "planner" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <Planner />
            </div>
            <div style={{ display: activeTab === "gamified" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <GamifiedLearning />
            </div>
            <div style={{ display: activeTab === "breaktime" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <Breaktime />
            </div>
            <div style={{ display: ["dashboard", "assignments", "classes"].includes(activeTab) ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <Dashboard
                key={`dashboard-${mode}-${authSession?.user?.user_id || "guest"}-${activeTab}`}
                active={["dashboard", "assignments", "classes"].includes(activeTab)}
                authSession={authSession}
                mode={mode}
                mentorSection={activeTab}
              />
            </div>
            <div style={{ display: activeTab === "account-settings" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <AccountSettings
                active={activeTab === "account-settings"}
                authSession={authSession}
                onLogout={handleLogout}
                onDirtyStateChange={handleDirtyStateChange}
                pushToast={pushToast}
              />
            </div>
            <div style={{ display: activeTab === "install" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <InstallApp
                installAvailable={installPromptAvailable || Boolean(deferredInstallPrompt)}
                onInstallClick={handleInstallClick}
                isInstalled={isInstalled}
              />
            </div>
            <div style={{ display: activeTab === "auth" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <AuthPage
                key={`${authPageMode}-${authSession?.user?.user_id || "guest"}`}
                mode={authPageMode}
                onAuthSuccess={(_user, meta) => {
                  refreshIdentity();
                  setActiveTab(meta?.source === "signup" ? "account-settings" : "dashboard");
                }}
                onBackToDashboard={() => setActiveTab("dashboard")}
              />
            </div>
            <div style={{ display: activeTab === "verification-success" ? "flex" : "none", flexDirection: "column", flex: 1 }}>
              <section className="account-settings-page auth-page">
                <div className="page-header account-settings-header">
                  <h2 className="card-title">Email Verified</h2>
                  <p className="card-subtitle">Verification is complete for this signup email.</p>
                </div>
                <section className="account-settings-grid">
                  <article className="account-settings-card account-settings-wide">
                    <p className="account-settings-meta">
                      {verificationMessage || "Email verified successfully. Please go back and complete the account creation."}
                    </p>
                    <p className="account-settings-meta">
                      Return to the PrepBro signup page. The button there will now change from <strong>Verify Email</strong> to <strong>Create Account</strong>.
                    </p>
                  </article>
                </section>
              </section>
            </div>
          </section>
        </section>
      </main>

      <SettingsBanner />
      <InstallBanner isInstalled={isInstalled} onOpenInstall={openInstallPage} />
      <FloatingSupport aiOpen={aiOpen} onAiOpenChange={setAiOpen} />
      <UserAccountPanel
        open={userPanelOpen}
        onClose={() => setUserPanelOpen(false)}
        onOpenAccountSettings={openAccountSettings}
        onOpenAuthPage={openAuthPage}
        onLogout={handleLogout}
      />

      {unsavedDialog && (
        <div className="unsaved-overlay" role="dialog" aria-modal="true" aria-label="Unsaved profile changes">
          <div className="unsaved-dialog">
            <h3 className="card-subheading">Unsaved Changes</h3>
            <p className="account-settings-meta">You have unsaved profile changes. Save, discard, or cancel before leaving this page.</p>
            <div className="account-settings-actions">
              <button
                className="btn-primary"
                type="button"
                onClick={async () => {
                  await accountSettingsHandlers.current.save?.();
                  setUnsavedDialog(null);
                  setActiveTab(unsavedDialog.nextTab);
                }}
              >
                Save
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  accountSettingsHandlers.current.discard?.();
                  setUnsavedDialog(null);
                  setActiveTab(unsavedDialog.nextTab);
                }}
              >
                Discard
              </button>
              <button className="btn-ghost" type="button" onClick={() => setUnsavedDialog(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

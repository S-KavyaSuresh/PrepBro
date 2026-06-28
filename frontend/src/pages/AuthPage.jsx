import React, { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch, withJsonBody } from "../lib/api.js";
import { clearAuthSession, saveAuthSession } from "../lib/auth.js";
import { fetchAccountProgress, hasGuestProgress, saveAccountProgress, syncGuestProgressToAccount } from "../lib/tracker.js";

const PASSWORD_HELP = "Minimum 8 characters, including uppercase, lowercase, and a number.";
const PASSWORD_TOO_LONG = "Password is too long. Please use 72 bytes or fewer.";
const SIGNUP_VERIFY_KEY = "prepbro_verified_signup_email";
const SIGNUP_DRAFT_KEY = "prepbro_signup_draft";

function emitToast(msg, type = "error") {
  window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg, type } }));
}

function emptyAuthForm() {
  return {
    role: "student",
    display_name: "",
    learner_age: "",
    gender: "",
    email: "",
    parent_guardian_email: "",
    mentor_email: "",
    learning_goal: "",
    preferred_subjects: "",
    daily_study_target_minutes: "",
    school_organization: "",
    class_handled: "",
    subject_department: "",
    password: "",
    confirmPassword: "",
  };
}

function validatePassword(password) {
  if (new TextEncoder().encode(password).length > 72) return PASSWORD_TOO_LONG;
  if (password.length < 8) return PASSWORD_HELP;
  if (!/[A-Z]/.test(password)) return PASSWORD_HELP;
  if (!/[a-z]/.test(password)) return PASSWORD_HELP;
  if (!/\d/.test(password)) return PASSWORD_HELP;
  return "";
}

function loadStoredSignupVerificationState() {
  const verifiedEmail = (localStorage.getItem(SIGNUP_VERIFY_KEY) || "").trim().toLowerCase();
  const storedDraft = localStorage.getItem(SIGNUP_DRAFT_KEY);
  if (!storedDraft) return { verifiedEmail, draft: null };
  try {
    return { verifiedEmail, draft: JSON.parse(storedDraft) };
  } catch {
    return { verifiedEmail, draft: null };
  }
}

function PasswordField({ id, label, value, onChange, visible, onToggle, showHelp = false, className = "" }) {
  return (
    <label className={`user-account-field ${className}`.trim()}>
      <span>{label}</span>
      <div className="password-field-wrap password-field">
        <input id={id} className="password-field-input" type={visible ? "text" : "password"} value={value} autoComplete="new-password" onChange={onChange} />
        <button className="password-toggle-btn" type="button" aria-label={visible ? `Hide ${label}` : `Show ${label}`} onClick={onToggle}>
          <span className="password-toggle-icon" aria-hidden="true">{visible ? "🙈" : "👁️"}</span>
        </button>
      </div>
      {showHelp && <span className="user-profile-meta">{PASSWORD_HELP}</span>}
    </label>
  );
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default function AuthPage({ mode = "signup", onAuthSuccess, onBackToDashboard }) {
  const [authMode, setAuthMode] = useState(mode);
  const [authForm, setAuthForm] = useState(emptyAuthForm);
  const [busy, setBusy] = useState(false);
  const [verifyingSignupEmail, setVerifyingSignupEmail] = useState(false);
  const [signupVerificationStatus, setSignupVerificationStatus] = useState("");
  const [signupVerificationPreviewUrl, setSignupVerificationPreviewUrl] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [guestImportModalOpen, setGuestImportModalOpen] = useState(false);
  const guestImportResolver = useRef(null);
  const [verifiedSignupEmail, setVerifiedSignupEmail] = useState(() => localStorage.getItem(SIGNUP_VERIFY_KEY) || "");
  const syncVerifiedSignupState = useMemo(() => () => {
    const { verifiedEmail, draft } = loadStoredSignupVerificationState();
    setVerifiedSignupEmail(verifiedEmail);
    if (!draft) return;
    setAuthForm((current) => ({
      ...emptyAuthForm(),
      ...draft,
      password: current.password,
      confirmPassword: current.confirmPassword,
    }));
  }, []);

  useEffect(() => {
    setAuthMode(mode);
    if (mode === "signup") {
      const { verifiedEmail, draft } = loadStoredSignupVerificationState();
      if (draft) {
        setAuthForm({ ...emptyAuthForm(), ...draft });
      } else if (verifiedEmail) {
        setAuthForm({
          ...emptyAuthForm(),
          email: verifiedEmail,
          parent_guardian_email: verifiedEmail,
        });
      } else {
        setAuthForm(emptyAuthForm());
      }
      setVerifiedSignupEmail(verifiedEmail);
    } else {
      setAuthForm(emptyAuthForm());
      setVerifiedSignupEmail("");
    }
    setShowPassword(false);
    setShowConfirmPassword(false);
    setSignupVerificationStatus("");
    setSignupVerificationPreviewUrl("");
  }, [mode]);

  useEffect(() => {
    if (authMode !== "signup") return;
    const refreshVerificationState = () => {
      syncVerifiedSignupState();
    };
    const handleStorage = (event) => {
      if (!event.key || event.key === SIGNUP_VERIFY_KEY || event.key === SIGNUP_DRAFT_KEY) {
        syncVerifiedSignupState();
      }
    };
    window.addEventListener("focus", refreshVerificationState);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", refreshVerificationState);
    return () => {
      window.removeEventListener("focus", refreshVerificationState);
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", refreshVerificationState);
    };
  }, [authMode, syncVerifiedSignupState]);

  const isStudent = authForm.role === "student";
  const learnerAge = Number(authForm.learner_age || 0);
  const isChildLearner = isStudent && authForm.learner_age !== "" && learnerAge <= 12;
  const signupAccountEmail = useMemo(() => {
    if (authMode !== "signup") return "";
    return (isStudent
      ? (isChildLearner ? authForm.parent_guardian_email : authForm.email)
      : authForm.email).trim().toLowerCase();
  }, [authMode, isStudent, isChildLearner, authForm.parent_guardian_email, authForm.email]);
  const signupEmailIsVerified = authMode === "signup" && Boolean(signupAccountEmail) && signupAccountEmail === verifiedSignupEmail;

  const roleSummary = useMemo(() => {
    if (authMode === "login") return "Sign in to load your PrepBro account and synced progress.";
    return isStudent
      ? "Start with the learner age, then PrepBro will show the right student account fields."
      : "Create a Mentor account to manage learners, assignments, and reports.";
  }, [authMode, isStudent]);

  const resetSensitiveFields = () => {
    setAuthForm((current) => ({ ...current, password: "", confirmPassword: "" }));
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  const buildSignupVerificationDraft = () => ({
    role: authForm.role,
    display_name: authForm.display_name,
    learner_age: authForm.learner_age,
    gender: authForm.gender,
    email: authForm.email,
    parent_guardian_email: authForm.parent_guardian_email,
    mentor_email: authForm.mentor_email,
    learning_goal: authForm.learning_goal,
    preferred_subjects: authForm.preferred_subjects,
    daily_study_target_minutes: authForm.daily_study_target_minutes,
    school_organization: authForm.school_organization,
    class_handled: authForm.class_handled,
    subject_department: authForm.subject_department,
  });

  useEffect(() => {
    if (!verifiedSignupEmail || authMode !== "signup") return;
    if (signupAccountEmail && signupAccountEmail !== verifiedSignupEmail) {
      setSignupVerificationStatus(`Verified email saved for ${verifiedSignupEmail}. Update the account email to match it or verify the new email.`);
      return;
    }
    if (signupAccountEmail && signupAccountEmail === verifiedSignupEmail) {
      setSignupVerificationStatus(`Email verified for ${verifiedSignupEmail}. You can create your account now.`);
    }
  }, [authMode, signupAccountEmail, verifiedSignupEmail]);

  useEffect(() => {
    if (signupEmailIsVerified) {
      setSignupVerificationStatus(`Email verified for ${verifiedSignupEmail}. You can create your account now.`);
    }
  }, [signupEmailIsVerified, verifiedSignupEmail]);

  useEffect(() => {
    if (authMode === "signup") {
      localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(authForm));
    }
  }, [authForm, authMode]);

  const validateSignup = () => {
    const passwordError = validatePassword(authForm.password);
    if (passwordError) return passwordError;
    if (authForm.password !== authForm.confirmPassword) return "Password confirmation does not match.";
    if (!authForm.display_name.trim()) return isStudent ? "Learner Name is required." : "Mentor Name is required.";
    if (!authForm.gender.trim()) return "Gender is required.";
    if (isStudent) {
      if (authForm.learner_age === "") return "Enter the age of the learner who will use PrepBro for studying.";
      if (!isChildLearner && !authForm.email.trim()) return "Learner Email is required.";
      if (!isChildLearner && !isValidEmail(authForm.email)) return "Please enter a valid learner email.";
      if (isChildLearner && !authForm.parent_guardian_email.trim()) return "Parent/Guardian Email is required for learners aged 12 or below.";
      if (authForm.parent_guardian_email.trim() && !isValidEmail(authForm.parent_guardian_email)) return "Please enter a valid Parent/Guardian Email.";
      if (authForm.mentor_email.trim() && !isValidEmail(authForm.mentor_email)) return "Please enter a valid Mentor Email.";
      const learnerEmail = isChildLearner ? "" : authForm.email.trim().toLowerCase();
      const parentEmail = authForm.parent_guardian_email.trim().toLowerCase();
      const mentorEmail = authForm.mentor_email.trim().toLowerCase();
      if (isChildLearner) {
        if (parentEmail && mentorEmail && parentEmail === mentorEmail) {
          return "Parent/Guardian Email and Mentor Email must be different.";
        }
      } else {
        if (learnerEmail && parentEmail && learnerEmail === parentEmail) {
          return "Learner Email and Parent/Guardian Email must be different.";
        }
        if (learnerEmail && mentorEmail && learnerEmail === mentorEmail) {
          return "Learner Email and Mentor Email must be different.";
        }
        if (parentEmail && mentorEmail && parentEmail === mentorEmail) {
          return "Parent/Guardian Email and Mentor Email must be different.";
        }
      }
    } else if (!authForm.email.trim()) {
      return "Mentor Email is required.";
    } else if (!isValidEmail(authForm.email)) {
      return "Please enter a valid Mentor Email.";
    }
    return "";
  };

  const buildSignupPayload = () => {
    if (isStudent) {
      return {
        role: "student",
        email: isChildLearner ? null : authForm.email.trim(),
        password: authForm.password,
        display_name: authForm.display_name.trim(),
        learner_age: authForm.learner_age === "" ? null : Number(authForm.learner_age),
        learning_goal: authForm.learning_goal.trim(),
        preferred_subjects: authForm.preferred_subjects.split(",").map((item) => item.trim()).filter(Boolean),
        daily_study_target_minutes: authForm.daily_study_target_minutes === "" ? null : Number(authForm.daily_study_target_minutes),
        parent_guardian_email: authForm.parent_guardian_email.trim() || null,
        teacher_email: authForm.mentor_email.trim() || null,
        preferences_json: {
          gender: authForm.gender.trim(),
        },
      };
    }
    return {
      role: "teacher",
      email: authForm.email.trim(),
      password: authForm.password,
      display_name: authForm.display_name.trim(),
      school_organization: authForm.school_organization.trim(),
      subject_department: authForm.subject_department.trim(),
      school_grade: authForm.class_handled.trim(),
      preferences_json: {
        gender: authForm.gender.trim(),
      },
    };
  };

  const responseZeroProgress = () => ({
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
  });

  const maybePromptGuestImport = async (user) => {
    if (user.role !== "student" || !hasGuestProgress()) return;
    const decision = await new Promise((resolve) => {
      guestImportResolver.current = resolve;
      setGuestImportModalOpen(true);
    });
    if (decision === "import") {
      await syncGuestProgressToAccount();
      await fetchAccountProgress().catch(() => {});
      return;
    }
    if (decision === "separate") {
      saveAccountProgress(responseZeroProgress());
    }
  };

  const handleSignup = async () => {
    if (!signupEmailIsVerified) {
      emitToast("Please verify this email before creating the account.", "error");
      return;
    }
    const validationError = validateSignup();
    if (validationError) {
      emitToast(validationError, "error");
      resetSensitiveFields();
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch("/signup", withJsonBody("POST", buildSignupPayload()));
      clearAuthSession();
      saveAuthSession({
        token: response.access_token,
        expires_at: response.expires_at,
        user: response.user,
      });
      saveAccountProgress(response.progress || responseZeroProgress());
      if (response.user.role === "student") {
        await maybePromptGuestImport(response.user);
        await fetchAccountProgress().catch(() => {});
      }
      emitToast("Account created successfully.", "success");
      localStorage.removeItem(SIGNUP_VERIFY_KEY);
      localStorage.removeItem(SIGNUP_DRAFT_KEY);
      setVerifiedSignupEmail("");
      setSignupVerificationStatus("");
      setSignupVerificationPreviewUrl("");
      setAuthForm(emptyAuthForm());
      onAuthSuccess?.(response.user, { source: "signup" });
    } catch (error) {
      emitToast(error.message || "Could not create account.", "error");
      resetSensitiveFields();
    } finally {
      setBusy(false);
    }
  };

  const handleRequestSignupVerification = async () => {
    if (!signupAccountEmail) {
      emitToast(isChildLearner ? "Enter Parent/Guardian Email first." : "Enter a valid account email first.", "error");
      return;
    }
    if (!isValidEmail(signupAccountEmail)) {
      emitToast("Please enter a valid email first.", "error");
      return;
    }
    setVerifyingSignupEmail(true);
    localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(authForm));
    setSignupVerificationStatus("");
    setSignupVerificationPreviewUrl("");
    try {
      const response = await apiFetch("/verification/request-signup", withJsonBody("POST", {
        email: signupAccountEmail,
        draft: buildSignupVerificationDraft(),
      }));
      if (response.sent) {
        setSignupVerificationStatus(`Verification email sent to ${signupAccountEmail}. Please check inbox or spam and verify it to continue.`);
        setSignupVerificationPreviewUrl(response.preview_verify_url || "");
        emitToast(`Verification email sent to ${signupAccountEmail}.`, "success");
      } else if (response.preview_verify_url) {
        setSignupVerificationStatus(`Verification preview generated for ${signupAccountEmail}. Open the link to continue.`);
        setSignupVerificationPreviewUrl(response.preview_verify_url);
        emitToast("Verification preview generated. Open the verification link to continue.", "success");
      } else {
        setSignupVerificationStatus(response.reason || "Could not send verification email.");
        emitToast(response.reason || "Could not send verification email.", "error");
      }
    } catch (error) {
      setSignupVerificationStatus(error.message || "Could not send verification email.");
      emitToast(error.message || "Could not send verification email.", "error");
    } finally {
      setVerifyingSignupEmail(false);
    }
  };

  const handleLogin = async () => {
    if (!authForm.email.trim() || !authForm.password.trim()) {
      emitToast("Email and password are required.", "error");
      resetSensitiveFields();
      return;
    }
    if (!isValidEmail(authForm.email)) {
      emitToast("Please enter a valid email and password.", "error");
      resetSensitiveFields();
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch("/login", withJsonBody("POST", {
        email: authForm.email.trim(),
        password: authForm.password,
      }));
      clearAuthSession();
      saveAuthSession({
        token: response.access_token,
        expires_at: response.expires_at,
        user: response.user,
      });
      saveAccountProgress(response.progress || responseZeroProgress());
      if (response.user.role === "student") {
        await maybePromptGuestImport(response.user);
        await fetchAccountProgress().catch(() => {});
      }
      emitToast("Logged in successfully.", "success");
      setAuthForm(emptyAuthForm());
      onAuthSuccess?.(response.user, { source: "login" });
    } catch (error) {
      emitToast(error.message || "Could not log in.", "error");
      resetSensitiveFields();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`account-settings-page auth-page ${authMode === "signup" ? "auth-page-signup" : "auth-page-login"}`}>
      <div className="page-header account-settings-header">
        <h2 className="card-title">{authMode === "login" ? "Log In" : "Create Account"}</h2>
        <p className="card-subtitle">{roleSummary}</p>
      </div>

      <section className="account-settings-grid">
        <article className="account-settings-card account-settings-wide">
          {authMode === "signup" && (
            <div className="role-options">
              <button className={`role-btn ${authForm.role === "student" ? "role-btn-active" : ""}`} type="button" onClick={() => setAuthForm((current) => ({ ...emptyAuthForm(), role: "student" }))}>Student</button>
              <button className={`role-btn ${authForm.role === "teacher" ? "role-btn-active" : ""}`} type="button" onClick={() => setAuthForm((current) => ({ ...emptyAuthForm(), role: "teacher" }))}>Mentor</button>
            </div>
          )}

          <div className="account-settings-form">
            {authMode === "signup" && isStudent && (
              <label className="user-account-field account-settings-field-wide">
                <span>Enter the age of the learner who will use PrepBro for studying.</span>
                <input type="number" value={authForm.learner_age} onChange={(event) => setAuthForm((current) => ({ ...current, learner_age: event.target.value }))} />
              </label>
            )}

            <label className={`user-account-field ${authMode === "login" ? "account-settings-field-wide" : ""}`.trim()}>
              <span>{authMode === "signup" && isStudent ? "Learner Name" : authMode === "signup" ? "Mentor Name" : "Email"}</span>
              {authMode === "login" ? (
                <input type="email" autoComplete="username" value={authForm.email} onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))} />
              ) : (
                <input value={authForm.display_name} onChange={(event) => setAuthForm((current) => ({ ...current, display_name: event.target.value }))} />
              )}
            </label>

            {authMode === "signup" && (
              <label className="user-account-field">
                <span>Gender</span>
                <select value={authForm.gender} onChange={(event) => setAuthForm((current) => ({ ...current, gender: event.target.value }))}>
                  <option value="">Select</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="non-binary">Non-binary</option>
                  <option value="prefer_not_to_say">Prefer not to say</option>
                </select>
              </label>
            )}

            {authMode === "signup" && isStudent && !isChildLearner && (
              <label className="user-account-field">
                <span>Learner Email</span>
                <input type="email" autoComplete="username" value={authForm.email} onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))} />
              </label>
            )}

            {authMode === "signup" && !isStudent && (
              <label className="user-account-field">
                <span>Mentor Email</span>
                <input type="email" autoComplete="username" value={authForm.email} onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))} />
              </label>
            )}

            {authMode === "signup" && isStudent && (
              <>
                <label className="user-account-field">
                  <span>Parent/Guardian Email</span>
                  <input type="email" value={authForm.parent_guardian_email} onChange={(event) => setAuthForm((current) => ({ ...current, parent_guardian_email: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Mentor Email</span>
                  <input type="email" value={authForm.mentor_email} onChange={(event) => setAuthForm((current) => ({ ...current, mentor_email: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Learning Goal</span>
                  <input value={authForm.learning_goal} onChange={(event) => setAuthForm((current) => ({ ...current, learning_goal: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Preferred Subjects</span>
                  <input value={authForm.preferred_subjects} placeholder="Math, Reading" onChange={(event) => setAuthForm((current) => ({ ...current, preferred_subjects: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Daily Study Target Minutes</span>
                  <input type="number" value={authForm.daily_study_target_minutes} onChange={(event) => setAuthForm((current) => ({ ...current, daily_study_target_minutes: event.target.value }))} />
                </label>
              </>
            )}

            {authMode === "signup" && !isStudent && (
              <>
                <label className="user-account-field">
                  <span>School / Organization</span>
                  <input value={authForm.school_organization} onChange={(event) => setAuthForm((current) => ({ ...current, school_organization: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Class handled / managed</span>
                  <input value={authForm.class_handled} onChange={(event) => setAuthForm((current) => ({ ...current, class_handled: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Subject / Department</span>
                  <input value={authForm.subject_department} onChange={(event) => setAuthForm((current) => ({ ...current, subject_department: event.target.value }))} />
                </label>
              </>
            )}

            {authMode === "login" ? (
              <PasswordField
                id="auth-password"
                label="Password"
                value={authForm.password}
                onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                visible={showPassword}
                onToggle={() => setShowPassword((current) => !current)}
                className="account-settings-field-wide"
              />
            ) : (
              <div className="password-row">
                <PasswordField
                  id="auth-password"
                  label="Password"
                  value={authForm.password}
                  onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                  visible={showPassword}
                  onToggle={() => setShowPassword((current) => !current)}
                  showHelp
                />
                <PasswordField
                  id="auth-confirm-password"
                  label="Confirm Password"
                  value={authForm.confirmPassword}
                  onChange={(event) => setAuthForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  visible={showConfirmPassword}
                  onToggle={() => setShowConfirmPassword((current) => !current)}
                />
              </div>
            )}
          </div>

          {authMode === "signup" && signupVerificationStatus ? (
            <div className="account-settings-note">
              <div>{signupVerificationStatus}</div>
              {signupVerificationPreviewUrl ? (
                <a className="account-settings-inline-link" href={signupVerificationPreviewUrl}>
                  Open verification link
                </a>
              ) : null}
            </div>
          ) : null}

          <div className="account-settings-actions">
            <button
              className="btn-primary"
              type="button"
              onClick={authMode === "signup" ? (signupEmailIsVerified ? handleSignup : handleRequestSignupVerification) : handleLogin}
              disabled={busy || verifyingSignupEmail}
            >
              {busy || verifyingSignupEmail
                ? "Please wait..."
                : authMode === "signup"
                  ? signupEmailIsVerified ? "Create Account" : "Verify Email"
                  : "Log In"}
            </button>
            <button className="btn-ghost" type="button" onClick={() => {
              setAuthMode((current) => (current === "signup" ? "login" : "signup"));
              setAuthForm(emptyAuthForm());
              localStorage.removeItem(SIGNUP_VERIFY_KEY);
              localStorage.removeItem(SIGNUP_DRAFT_KEY);
              setVerifiedSignupEmail("");
              setSignupVerificationStatus("");
              setSignupVerificationPreviewUrl("");
            }}>
              {authMode === "signup" ? "Already have an account?" : "Need an account?"}
            </button>
            <button className="btn-ghost" type="button" onClick={onBackToDashboard}>Back</button>
          </div>
        </article>
      </section>

      {guestImportModalOpen && (
        <div className="unsaved-overlay" role="dialog" aria-modal="true" aria-label="Import guest progress">
          <div className="unsaved-dialog guest-import-dialog">
            <h3 className="card-subheading">Import Guest Progress?</h3>
            <p className="account-settings-meta">You have guest progress saved on this device. Choose whether to import it into this account or keep it separate.</p>
            <div className="account-settings-actions">
              <button
                className="btn-primary"
                type="button"
                onClick={() => {
                  setGuestImportModalOpen(false);
                  guestImportResolver.current?.("import");
                  guestImportResolver.current = null;
                }}
              >
                Import Guest Progress
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  setGuestImportModalOpen(false);
                  guestImportResolver.current?.("separate");
                  guestImportResolver.current = null;
                }}
              >
                Keep Separate
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  setGuestImportModalOpen(false);
                  guestImportResolver.current?.("cancel");
                  guestImportResolver.current = null;
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../lib/api.js";
import { clearAuthSession, saveAuthSession } from "../lib/auth.js";
import { fetchAccountProgress } from "../lib/tracker.js";

function toForm(user) {
  const preferences = user?.preferences_json || {};
  return {
    display_name: user?.display_name || "",
    age: user?.age ?? "",
    gender: preferences.gender || "",
    learning_goal: user?.learning_goal || preferences.learning_goal || "",
    preferred_subjects: (preferences.preferred_subjects || []).join(", "),
    daily_study_target_minutes: preferences.daily_study_target_minutes ?? "",
    parent_guardian_email: preferences.parent_guardian_email || "",
    teacher_email: preferences.teacher_email || "",
    school_grade: preferences.school_grade || "",
    school_organization: preferences.school_organization || "",
    subject_department: preferences.subject_department || "",
    profile_photo_data: preferences.profile_photo_data || "",
  };
}

function profileRows(profile, role) {
  const preferences = profile?.preferences_json || {};
  if (role === "teacher") {
    return [
      ["Mentor Name", profile?.display_name || "Not set"],
      ["Mentor Email", profile?.email || "Not set"],
      ["Role", "Mentor"],
      ["School / Organization", preferences.school_organization || "Not set"],
      ["Subject / Department", preferences.subject_department || "Not set"],
    ];
  }
  return [
    ["Name", profile?.display_name || "Not set"],
    ["Email", profile?.email || "Not set"],
    ["Role", "Student"],
    ["Learner Age", profile?.age ?? "Not set"],
    ["Gender", preferences.gender || "Not set"],
    ["Learning Goal", profile?.learning_goal || preferences.learning_goal || "Not set"],
    ["Preferred Subjects", (preferences.preferred_subjects || []).join(", ") || "Not set"],
    ["Daily Study Target Minutes", preferences.daily_study_target_minutes ?? "Not set"],
    ["Parent/Guardian Email", preferences.parent_guardian_email || "Not set"],
    ["Mentor Email", preferences.teacher_email || "Not set"],
  ];
}

export default function AccountSettings({
  active,
  authSession,
  onLogout,
  onDirtyStateChange,
  pushToast,
}) {
  const role = authSession?.user?.role || "student";
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [profile, setProfile] = useState(authSession?.user || null);
  const [profileForm, setProfileForm] = useState(toForm(authSession?.user));
  const [initialForm, setInitialForm] = useState(toForm(authSession?.user));
  const [statusMessage, setStatusMessage] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [photoPromptOpen, setPhotoPromptOpen] = useState(false);
  const photoInputRef = useRef(null);

  const handleProfilePhotoChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      pushToast("Please choose an image file.", "error");
      return;
    }
    if (file.size > 1024 * 1024) {
      pushToast("Profile photo must be 1 MB or smaller.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setEditMode(true);
      setProfileForm((current) => ({ ...current, profile_photo_data: String(reader.result || "") }));
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const dirty = useMemo(
    () => JSON.stringify(profileForm) !== JSON.stringify(initialForm),
    [profileForm, initialForm],
  );

  const refreshData = async ({ silent = false } = {}) => {
    if (!authSession?.token) return;
    if (!silent) setLoading(true);
    setStatusMessage("");
    try {
      const freshProfile = await apiFetch("/profile");
      saveAuthSession({ ...authSession, user: freshProfile });
      setProfile(freshProfile);
      const nextForm = toForm(freshProfile);
      setProfileForm(nextForm);
      setInitialForm(nextForm);
      setShowDeleteConfirm(false);
      if (freshProfile.role === "student") {
        await fetchAccountProgress().catch(() => {});
      }
      if (!silent) pushToast("Account data synced.", "success");
    } catch (error) {
      if (error.status === 401) {
        clearAuthSession();
        onLogout?.();
        return;
      }
      setStatusMessage(error.message || "Could not refresh account data.");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!active || !authSession?.token) return;
    void refreshData({ silent: false });
  }, [active, authSession?.token]);

  useEffect(() => {
    setShowDeleteConfirm(false);
    setEditMode(false);
  }, [authSession?.user?.user_id]);

  useEffect(() => {
    if (!active) return undefined;
    const beforeUnload = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [active, dirty]);

  useEffect(() => {
    onDirtyStateChange?.({
      dirty: editMode && dirty,
      save: async () => {
        await handleSaveProfile();
      },
      discard: () => {
        setProfileForm(initialForm);
        setEditMode(false);
        setStatusMessage("Unsaved changes were discarded.");
      },
    });
  }, [editMode, dirty, profileForm, initialForm]);

  const handleSaveProfile = async () => {
    setSaving(true);
    setStatusMessage("");
    try {
      const preferences_json = role === "teacher"
        ? {
            school_organization: profileForm.school_organization.trim(),
            subject_department: profileForm.subject_department.trim(),
            school_grade: profileForm.school_grade.trim(),
            profile_photo_data: profileForm.profile_photo_data || null,
          }
        : {
            gender: profileForm.gender.trim(),
            preferred_subjects: profileForm.preferred_subjects.split(",").map((item) => item.trim()).filter(Boolean),
            daily_study_target_minutes: profileForm.daily_study_target_minutes === "" ? null : Number(profileForm.daily_study_target_minutes),
            parent_guardian_email: profileForm.parent_guardian_email.trim() || null,
            teacher_email: profileForm.teacher_email.trim() || null,
            school_grade: profileForm.school_grade.trim(),
            profile_photo_data: profileForm.profile_photo_data || null,
          };
      const payload = {
        display_name: profileForm.display_name.trim(),
        age: role === "student" ? (profileForm.age === "" ? null : Number(profileForm.age)) : null,
        learning_goal: role === "student" ? profileForm.learning_goal.trim() : "",
        preferences_json,
      };
      const updated = await apiFetch("/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });
      saveAuthSession({ ...authSession, user: updated });
      setProfile(updated);
      const nextForm = toForm(updated);
      setProfileForm(nextForm);
      setInitialForm(nextForm);
      setEditMode(false);
      pushToast("Profile saved.", "success");
    } catch (error) {
      setStatusMessage(error.message || "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await apiFetch("/account", { method: "DELETE" });
      clearAuthSession();
      setShowDeleteConfirm(false);
      pushToast("Account deleted.", "success");
      onLogout?.();
    } catch (error) {
      setStatusMessage(error.message || "Could not delete account.");
    }
  };

  const linkedStatuses = profile?.linked_email_statuses || {};

  if (!authSession?.token) {
    return <div className="account-settings-page"><div className="empty-state">Log in to access account settings.</div></div>;
  }

  return (
    <div className="account-settings-page">
      <div className="page-header account-settings-header">
        <h2 className="card-title">Account Settings</h2>
        <p className="card-subtitle">Manage your PrepBro profile, verification, synced progress, and account preferences.</p>
      </div>

      {statusMessage && <div className="account-settings-note">{statusMessage}</div>}

      <section className="account-settings-grid">
        <article className="account-settings-card">
          <div className="account-settings-card-head">
            <div className="account-profile-heading">
              <button className="account-profile-photo-trigger" type="button" onClick={() => setPhotoPromptOpen(true)} aria-label={profileForm.profile_photo_data ? "Change profile photo" : "Set profile photo"}>
                {profileForm.profile_photo_data ? (
                  <img src={profileForm.profile_photo_data} alt="Profile" className="account-profile-photo" />
                ) : (
                  <div className="account-profile-photo account-profile-photo-fallback">
                    {(profile?.display_name || profile?.email || "U").slice(0, 1).toUpperCase()}
                  </div>
                )}
              </button>
              <div>
                <h3 className="card-subheading">Profile Details</h3>
                <p className="account-settings-meta">{profile?.email}</p>
              </div>
            </div>
            <span className={`install-status-pill ${profile?.is_verified ? "install-status-pill-installed" : ""}`}>
              {profile?.is_verified ? "Verified" : "Not Verified"}
            </span>
          </div>

          {!editMode ? (
            <div className="profile-summary-list">
              {profileRows(profile, role).map(([label, value]) => (
                <div key={label} className="profile-summary-row">
                  <span>{label}</span>
                  <strong>{String(value)}</strong>
                </div>
              ))}
              {role === "student" && linkedStatuses.teacher_email?.email && (
                <div className="profile-summary-row">
                  <span>Mentor Link Status</span>
                  <strong>{linkedStatuses.teacher_email.verified ? "Verified mentor account" : "Mentor account not verified"}</strong>
                </div>
              )}
            </div>
          ) : (
            <div className="account-settings-form">
              <div className="account-settings-field-wide profile-photo-editor">
                <span className="profile-photo-label">Profile Photo</span>
                <div className="profile-photo-actions">
                  {profileForm.profile_photo_data ? (
                    <img src={profileForm.profile_photo_data} alt="Profile preview" className="account-profile-photo account-profile-photo-large" />
                  ) : (
                    <div className="account-profile-photo account-profile-photo-large account-profile-photo-fallback">
                      {(profileForm.display_name || profile?.email || "U").slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="account-settings-actions">
                    <button className="btn-ghost profile-photo-upload-btn" type="button" onClick={() => photoInputRef.current?.click()}>
                      {profileForm.profile_photo_data ? "Change Photo" : "Choose Profile Photo"}
                    </button>
                    {profileForm.profile_photo_data && (
                      <button
                        className="btn-ghost"
                        type="button"
                        onClick={() => {
                          setEditMode(true);
                          setProfileForm((current) => ({ ...current, profile_photo_data: "" }));
                        }}
                      >
                        Remove Photo
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <label className="user-account-field">
                <span>{role === "teacher" ? "Mentor Name" : "Name"}</span>
                <input value={profileForm.display_name} onChange={(event) => setProfileForm((current) => ({ ...current, display_name: event.target.value }))} />
              </label>
              {role === "student" && (
                <>
                  <label className="user-account-field">
                    <span>Enter the age of the learner who will use PrepBro for studying.</span>
                    <input type="number" value={profileForm.age} onChange={(event) => setProfileForm((current) => ({ ...current, age: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Gender</span>
                    <input value={profileForm.gender} onChange={(event) => setProfileForm((current) => ({ ...current, gender: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Learning Goal</span>
                    <input value={profileForm.learning_goal} onChange={(event) => setProfileForm((current) => ({ ...current, learning_goal: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Preferred Subjects</span>
                    <input value={profileForm.preferred_subjects} onChange={(event) => setProfileForm((current) => ({ ...current, preferred_subjects: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Daily Study Target Minutes</span>
                    <input type="number" value={profileForm.daily_study_target_minutes} onChange={(event) => setProfileForm((current) => ({ ...current, daily_study_target_minutes: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Parent/Guardian Email</span>
                    <input type="email" value={profileForm.parent_guardian_email} onChange={(event) => setProfileForm((current) => ({ ...current, parent_guardian_email: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Mentor Email</span>
                    <input type="email" value={profileForm.teacher_email} onChange={(event) => setProfileForm((current) => ({ ...current, teacher_email: event.target.value }))} />
                  </label>
                </>
              )}
              {role === "teacher" && (
                <>
                  <label className="user-account-field">
                    <span>School / Organization</span>
                    <input value={profileForm.school_organization} onChange={(event) => setProfileForm((current) => ({ ...current, school_organization: event.target.value }))} />
                  </label>
                  <label className="user-account-field">
                    <span>Subject / Department</span>
                    <input value={profileForm.subject_department} onChange={(event) => setProfileForm((current) => ({ ...current, subject_department: event.target.value }))} />
                  </label>
                </>
              )}
            </div>
          )}

          <div className="account-settings-actions">
            {!editMode ? (
              <button className="btn-primary" type="button" onClick={() => setEditMode(true)}>Edit Profile</button>
            ) : (
              <>
                <button className="btn-primary" type="button" onClick={handleSaveProfile} disabled={saving}>
                  {saving ? "Saving..." : "Save Profile"}
                </button>
                <button className="btn-ghost" type="button" onClick={() => { setProfileForm(initialForm); setEditMode(false); }}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </article>

        <article className="account-settings-card">
          <div className="account-settings-card-head">
            <div>
              <h3 className="card-subheading">Account Actions</h3>
              <p className="account-settings-meta">Role: {profile?.role === "teacher" ? "Mentor" : "Student"}</p>
            </div>
          </div>
          <div className="account-settings-actions">
            <button className="btn-ghost" type="button" onClick={() => { clearAuthSession(); setShowDeleteConfirm(false); onLogout?.(); }}>Log Out</button>
          </div>
          <div className="account-danger-zone">
            <h4 className="card-subheading">Danger Zone</h4>
            <p className="account-settings-meta">This will permanently delete your account and saved progress.</p>
            {!showDeleteConfirm ? (
              <button className="btn-danger" type="button" onClick={() => setShowDeleteConfirm(true)}>Delete Account</button>
            ) : (
              <div className="account-settings-actions">
                <button className="btn-danger" type="button" onClick={handleDeleteAccount}>Confirm Delete</button>
                <button className="btn-ghost" type="button" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              </div>
            )}
          </div>
        </article>
      </section>

      <input ref={photoInputRef} type="file" accept="image/*" onChange={handleProfilePhotoChange} hidden />

      {photoPromptOpen && (
        <div className="unsaved-overlay" role="dialog" aria-modal="true" aria-label="Profile photo options">
          <div className="unsaved-dialog avatar-photo-dialog">
            <h3 className="card-subheading">{profileForm.profile_photo_data ? "Profile Photo" : "Set Profile Photo?"}</h3>
            <p className="account-settings-meta">
              {profileForm.profile_photo_data
                ? "Choose a new profile photo, remove the current one, or cancel."
                : "You do not have a profile photo yet. Would you like to add one now?"}
            </p>
            <div className="account-settings-actions">
              <button className="btn-primary" type="button" onClick={() => { setPhotoPromptOpen(false); photoInputRef.current?.click(); }}>
                {profileForm.profile_photo_data ? "Change Photo" : "Choose Photo"}
              </button>
              {profileForm.profile_photo_data ? (
                <>
                  <button
                    className="btn-danger"
                    type="button"
                    onClick={() => {
                      setEditMode(true);
                      setProfileForm((current) => ({ ...current, profile_photo_data: "" }));
                      setPhotoPromptOpen(false);
                    }}
                  >
                    Remove Photo
                  </button>
                  <button className="btn-ghost" type="button" onClick={() => setPhotoPromptOpen(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn-ghost" type="button" onClick={() => setPhotoPromptOpen(false)}>
                  Later
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

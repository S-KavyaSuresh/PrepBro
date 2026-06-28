import React, { useEffect, useRef, useState } from "react";

import { apiFetch } from "../lib/api.js";
import { clearAuthSession, getAvatarDataFromUser, loadAuthSession, saveAuthSession } from "../lib/auth.js";

function emitToast(msg, type = "error") {
  window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg, type } }));
}

function buildProfilePhotoPayload(user, profilePhotoData) {
  const preferences = user?.preferences_json || {};
  return {
    display_name: user?.display_name || "",
    age: user?.role === "student" ? user?.age ?? null : null,
    learning_goal: user?.role === "student" ? (user?.learning_goal || preferences.learning_goal || "") : "",
    preferences_json: {
      ...preferences,
      profile_photo_data: profilePhotoData || null,
    },
  };
}

export default function UserAccountPanel({
  open,
  onClose,
  onOpenAccountSettings,
  onOpenAuthPage,
  onLogout,
}) {
  const authSession = loadAuthSession();
  const isLoggedIn = Boolean(authSession?.token);
  const avatarData = getAvatarDataFromUser(authSession?.user);
  const [photoPromptOpen, setPhotoPromptOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  const modalRef = useRef(null);

  const openPhotoPicker = () => {
    setPhotoPromptOpen(false);
    window.requestAnimationFrame(() => {
      const input = fileInputRef.current;
      if (!input) return;
      if (typeof input.showPicker === "function") {
        input.showPicker();
      } else {
        input.click();
      }
    });
  };

  useEffect(() => {
    if (!open) {
      setPhotoPromptOpen(false);
      return undefined;
    }
    function onClick(event) {
      const panel = panelRef.current;
      const anchor = document.getElementById("userAccountButton");
      const modal = modalRef.current;
      if (photoPromptOpen && modal && !modal.contains(event.target)) {
        setPhotoPromptOpen(false);
        return;
      }
      if (panel && !panel.contains(event.target) && anchor && !anchor.contains(event.target)) onClose?.();
    }
    function onKeyDown(event) {
      if (event.key === "Escape") {
        if (photoPromptOpen) {
          setPhotoPromptOpen(false);
        } else {
          onClose?.();
        }
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, photoPromptOpen]);

  const saveProfilePhoto = async (profilePhotoData) => {
    if (!authSession?.user) return;
    setPhotoBusy(true);
    try {
      const updated = await apiFetch("/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildProfilePhotoPayload(authSession.user, profilePhotoData)),
      });
      saveAuthSession({
        token: authSession.token,
        expires_at: authSession.expires_at,
        user: updated,
      });
      emitToast(profilePhotoData ? "Profile photo updated." : "Profile photo removed.", "success");
      setPhotoPromptOpen(false);
    } catch (error) {
      emitToast(error.message || "Could not update profile photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const handlePhotoFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      emitToast("Please choose an image file.", "error");
      event.target.value = "";
      return;
    }
    if (file.size > 1024 * 1024) {
      emitToast("Profile photo must be 1 MB or smaller.", "error");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      await saveProfilePhoto(String(reader.result || ""));
      event.target.value = "";
    };
    reader.readAsDataURL(file);
  };

  if (!open) return null;

  return (
    <>
      <section ref={panelRef} className="user-account-panel user-account-panel-open" id="userAccountPanel">
        {!isLoggedIn ? (
          <>
            <div className="user-profile-header">
              <div className="user-big-avatar">G</div>
              <div>
                <div className="user-account-title">Guest</div>
                <div className="user-profile-meta">Use guest mode or open a full account page to sign up or log in.</div>
              </div>
            </div>
            <div className="user-account-actions">
              <button className="btn-primary" type="button" onClick={() => { onClose?.(); onOpenAuthPage?.("signup"); }}>
                Create Account
              </button>
              <button className="btn-ghost" type="button" onClick={() => { onClose?.(); onOpenAuthPage?.("login"); }}>
                Log In
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="user-profile-header">
              <button className="user-profile-avatar-trigger" type="button" onClick={() => setPhotoPromptOpen(true)} aria-label={avatarData ? "Change profile photo" : "Set profile photo"}>
                {avatarData ? (
                  <img src={avatarData} alt="Profile" className="user-big-avatar-photo" />
                ) : (
                  <div className="user-big-avatar">{(authSession?.user?.display_name || authSession?.user?.email || "U").slice(0, 1).toUpperCase()}</div>
                )}
              </button>
              <div>
                <div className="user-account-title">{authSession?.user?.display_name || authSession?.user?.email}</div>
                <div className="user-profile-meta user-profile-meta-email">{authSession?.user?.email}</div>
              </div>
            </div>
            <div className="user-account-actions">
              <button className="btn-primary" type="button" onClick={() => { onClose?.(); onOpenAccountSettings?.(); }}>
                View Account Settings
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  clearAuthSession();
                  onClose?.();
                  onLogout?.();
                }}
              >
                Log Out
              </button>
            </div>
          </>
        )}
      </section>

      {isLoggedIn && photoPromptOpen && (
        <div className="unsaved-overlay" role="dialog" aria-modal="true" aria-label="Profile photo options">
          <div ref={modalRef} className="unsaved-dialog avatar-photo-dialog" id="profilePhotoPrompt" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="card-subheading">{avatarData ? "Profile Photo" : "Set Profile Photo?"}</h3>
            <p className="account-settings-meta">
              {avatarData
                ? "Choose a new photo or remove the current one."
                : "You have not set a profile photo yet. Would you like to add one now?"}
            </p>
            <div className="account-settings-actions">
              <button className="btn-primary" type="button" disabled={photoBusy} onClick={openPhotoPicker}>
                {avatarData ? "Change Photo" : "Choose Photo"}
              </button>
              {avatarData ? (
                <>
                  <button className="btn-danger" type="button" disabled={photoBusy} onClick={() => void saveProfilePhoto("")}>
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

      <input ref={fileInputRef} type="file" hidden accept="image/*" onChange={handlePhotoFile} />
    </>
  );
}

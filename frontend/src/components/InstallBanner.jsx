import React, { useEffect, useState } from "react";

const DISMISS_KEY = "prepbro_install_banner_dismissed";

export default function InstallBanner({ isInstalled, onOpenInstall }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  useEffect(() => {
    if (isInstalled) {
      setDismissed(true);
    }
  }, [isInstalled]);

  if (dismissed || isInstalled) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="install-banner" role="region" aria-label="Install PrepBro">
      <div className="install-banner-main">
        <img src="/icons/prepbro-192-final.png?v=prepbro-icon-safe" alt="PrepBro icon" className="prepbro-app-icon install-banner-icon" />
        <div className="install-banner-copy">
          <div className="install-banner-title">Install PrepBro</div>
          <div className="install-banner-text">Get faster access from your desktop, Android home screen, or browser app launcher.</div>
        </div>
      </div>
      <div className="install-banner-actions">
        <button className="btn-primary install-action-btn" type="button" onClick={onOpenInstall}>
          Install App
        </button>
        <button className="install-banner-close" type="button" onClick={handleDismiss} aria-label="Dismiss install banner">
          x
        </button>
      </div>
    </div>
  );
}

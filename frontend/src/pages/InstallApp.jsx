import React, { useMemo, useState } from "react";

const INSTALL_TABS = [
{ id: "pc", label: "Install for PC" },
{ id: "mobile", label: "Install for Mobile" },
{ id: "web", label: "Install Web App" },
];

const WINDOWS_INSTALLER_URL =
import.meta.env.VITE_WINDOWS_INSTALLER_URL ||
"https://github.com/S-KavyaSuresh/PrepBro/releases/download/v2.1.0/PrepBro.Setup.1.0.0.exe";

const ANDROID_APK_URL =
import.meta.env.VITE_ANDROID_APK_URL ||
"https://github.com/S-KavyaSuresh/PrepBro/releases/download/v2.1.0/PrepBro-Android.apk";

function getWebInstallState({ isInstalled, installAvailable }) {
if (isInstalled) {
return {
pill: "Installed",
button: "Installed",
disabled: true,
copy: "PrepBro is already installed on this device. You can open it like a regular app from your launcher or desktop.",
};
}

if (installAvailable) {
return {
pill: "Install Web App",
button: "Install Web App",
disabled: false,
copy: "This option uses the browser PWA install flow. Click the button below when your browser offers the install prompt.",
};
}

return {
pill: "Use Browser Menu",
button: "Use Browser Menu",
disabled: true,
copy: "Your browser did not expose an install prompt right now, so use the manual browser steps below.",
};
}

export default function InstallApp({
installAvailable,
onInstallClick,
isInstalled,
desktopVersion = "v1.0.0",
mobileVersion = "v1.0.0",
webVersion = "v1.0.0",
}) {
const [activeTab, setActiveTab] = useState("pc");

const webInstructions = useMemo(
() => [
"Chrome/Edge desktop: browser menu -> Cast, save, and share / Apps -> Install this site as an app",
"Android Chrome: browser menu -> Add to Home screen / Install app",
"iPhone Safari: Share button -> Add to Home Screen",
],
[]
);

const webState = getWebInstallState({ isInstalled, installAvailable });

return ( <div className="install-page"> <div className="page-header install-page-header"> <div className="install-hero"> <img
         src="/icons/prepbro-192-final.png?v=prepbro-icon-safe"
         alt="PrepBro icon"
         className="prepbro-app-icon install-hero-icon"
       /> <div> <h2 className="card-title">Install PrepBro</h2> <p className="card-subtitle">
Choose how you want to access PrepBro across desktop, mobile, and the web app experience. </p> </div> </div> </div>

```
  <div className="install-tab-row" role="tablist" aria-label="Install options">
    {INSTALL_TABS.map((tab) => (
      <button
        key={tab.id}
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        className={`install-tab-btn ${activeTab === tab.id ? "install-tab-btn-active" : ""}`}
        onClick={() => setActiveTab(tab.id)}
      >
        {tab.label}
      </button>
    ))}
  </div>

  {activeTab === "pc" && (
    <section className="install-card">
      <div className="install-card-header">
        <div className="install-card-heading">
          <img
            src="/icons/prepbro-64-final.png?v=prepbro-icon-safe"
            alt="PrepBro icon"
            className="prepbro-app-icon install-card-icon"
          />
          <div>
            <h3 className="card-subheading">Install for PC</h3>
            <div className="install-version">{desktopVersion}</div>
          </div>
        </div>
        <span className="install-status-pill install-status-pill-installed">Available</span>
      </div>

      <p className="install-copy">
        Download the Windows installer and install PrepBro as a desktop app on your PC.
      </p>

      <div className="install-action-row">
        <a
          className="btn-primary install-action-btn"
          href={WINDOWS_INSTALLER_URL}
          target="_blank"
          rel="noopener noreferrer"
          download
        >
          Download for Windows
        </a>
      </div>

      <div className="install-instructions">
        <h4 className="install-instructions-title">Installation notes</h4>
        <ul className="install-instructions-list">
          <li>Download the Windows installer.</li>
          <li>Open the downloaded file: PrepBro.Setup.1.0.0.exe.</li>
          <li>If Windows shows a security warning, choose More info → Run anyway.</li>
          <li>After installation, open PrepBro from the desktop or Start menu.</li>
        </ul>
      </div>
    </section>
  )}

  {activeTab === "mobile" && (
    <section className="install-card">
      <div className="install-card-header">
        <div className="install-card-heading">
          <img
            src="/icons/prepbro-64-final.png?v=prepbro-icon-safe"
            alt="PrepBro icon"
            className="prepbro-app-icon install-card-icon"
          />
          <div>
            <h3 className="card-subheading">Install for Mobile</h3>
            <div className="install-version">{mobileVersion}</div>
          </div>
        </div>
        <span className="install-status-pill install-status-pill-installed">Available</span>
      </div>

      <p className="install-copy">
        Download the Android APK and install PrepBro on your phone for a mobile app experience.
      </p>

      <div className="install-action-row">
        <a
          className="btn-primary install-action-btn"
          href={ANDROID_APK_URL}
          target="_blank"
          rel="noopener noreferrer"
          download
        >
          Download Android APK
        </a>
      </div>

      <div className="install-instructions">
        <h4 className="install-instructions-title">Installation notes</h4>
        <ul className="install-instructions-list">
          <li>Download the APK file: PrepBro-Android.apk.</li>
          <li>Open the file on your Android phone.</li>
          <li>If asked, allow installation from unknown sources for your browser/file manager.</li>
          <li>After installation, open PrepBro from your app drawer.</li>
        </ul>
      </div>
    </section>
  )}

  {activeTab === "web" && (
    <section className="install-card">
      <div className="install-card-header">
        <div className="install-card-heading">
          <img
            src="/icons/prepbro-64-final.png?v=prepbro-icon-safe"
            alt="PrepBro icon"
            className="prepbro-app-icon install-card-icon"
          />
          <div>
            <h3 className="card-subheading">Install Web App</h3>
            <div className="install-version">{webVersion}</div>
          </div>
        </div>
        <span className={`install-status-pill ${isInstalled ? "install-status-pill-installed" : ""}`}>
          {webState.pill}
        </span>
      </div>

      <p className="install-copy">{webState.copy}</p>

      <div className="install-action-row">
        <button
          className="btn-primary install-action-btn"
          type="button"
          onClick={onInstallClick}
          disabled={webState.disabled}
        >
          {webState.button}
        </button>
      </div>

      {!isInstalled && (
        <div className="install-instructions">
          <h4 className="install-instructions-title">Manual install instructions</h4>
          <ul className="install-instructions-list">
            {webInstructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )}
</div>

);
}

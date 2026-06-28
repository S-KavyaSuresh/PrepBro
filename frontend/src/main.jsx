import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { initializeAuthStorage } from "./lib/auth.js";
import { initializeTrackerStorage } from "./lib/tracker.js";

initializeAuthStorage();
initializeTrackerStorage();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  const unregisterExistingWorkers = async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key.startsWith("prepbro-") || key.includes("mindbloom") || key.includes("dyslearn"))
          .map((key) => caches.delete(key)),
      );
    }
  };

  if (import.meta.env.PROD) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").then((registration) => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;
          installingWorker.addEventListener("statechange", () => {
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
              registration.waiting?.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      }).catch(() => {});
    });
  } else {
    void unregisterExistingWorkers().catch(() => {});
  }
}


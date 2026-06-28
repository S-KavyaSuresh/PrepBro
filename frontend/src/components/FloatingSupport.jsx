import React, { useState } from "react";
import AIAssistant from "./AIAssistant.jsx";

export default function FloatingSupport({ aiOpen, onAiOpenChange }) {
  const [encouragement, setEncouragement] = useState("");
  const [loadingEncouragement, setLoadingEncouragement] = useState(false);
  const [showToast, setShowToast] = useState("");

  const triggerEncouragement = async () => {
    if (loadingEncouragement) return;
    setLoadingEncouragement(true);
    try {
      const { apiFetch } = await import("../lib/api.js");
      const varieties = [
        "Say something about believing in yourself.",
        "Say something about how effort leads to growth.",
        "Say something about small wins adding up.",
        "Say something about the power of keeping going.",
        "Say something about how mistakes help us learn.",
      ];
      const randomVariety = varieties[Math.floor(Math.random() * varieties.length)];
      const data = await apiFetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Give me a very short (2-3 sentences max) unique encouraging message for a student. ${randomVariety}`,
        }),
      });
      setShowToast(data.answer || "You are doing great. Keep going.");
      setTimeout(() => setShowToast(""), 6000);
    } catch {
      const fallbacks = [
        "You are doing brilliantly. Every effort you make counts.",
        "Believe in yourself. Small steps lead to big results.",
        "You have got this. Every challenge helps you grow.",
      ];
      setShowToast(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
      setTimeout(() => setShowToast(""), 5000);
    } finally {
      setLoadingEncouragement(false);
    }
  };

  return (
    <>
      {showToast && (
        <div className="encouragement-toast" role="alert">
          <span className="encouragement-toast-emoji" aria-hidden="true">💪</span>
          <p className="encouragement-toast-text">{showToast}</p>
          <button className="encouragement-toast-close" type="button" onClick={() => setShowToast("")}>
            x
          </button>
        </div>
      )}

      <div className={`floating-support ${showToast ? "floating-support-toast-open" : ""}`}>
        {!showToast && (
          <button
            className={`encouragement-button ${loadingEncouragement ? "encouragement-loading" : ""}`}
            type="button"
            onClick={triggerEncouragement}
            disabled={loadingEncouragement}
            title="Need a boost? Click for encouragement."
          >
            <span aria-hidden="true">{loadingEncouragement ? "..." : "💪"}</span>
            <span>{loadingEncouragement ? "Loading..." : "Need encouragement?"}</span>
          </button>
        )}

        <button
          className="ai-assistant-fab"
          type="button"
          aria-label="Open AI Study Assistant"
          onClick={() => onAiOpenChange(true)}
          title="Open AI Study Assistant"
        >
          <span aria-hidden="true">🤖</span>
          <span className="fab-label">AI</span>
        </button>
      </div>

      <AIAssistant
        open={aiOpen}
        onClose={() => onAiOpenChange(false)}
        encouragement={encouragement}
        onClearEncouragement={() => setEncouragement("")}
      />
    </>
  );
}

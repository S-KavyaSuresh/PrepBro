import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

export default function AIAssistant({ open, onClose, encouragement, onClearEncouragement }) {
  const [messages, setMessages] = useState([
    { role: "bot", text: "Hi! 👋 I'm your study buddy. Ask me anything about your studies!" },
  ]);
  const [input, setInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (!encouragement) return;
    setMessages((prev) => [...prev, { role: "bot", text: encouragement }]);
    onClearEncouragement?.();
  }, [encouragement, onClearEncouragement]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }, { role: "bot", text: "Thinking…", loading: true }]);

    try {
      const data = await apiFetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      setMessages((prev) => {
        const copy = [...prev];
        const idx = copy.findLastIndex((m) => m.loading);
        if (idx >= 0) copy[idx] = { role: "bot", text: data.answer || "I couldn't answer that." };
        return copy;
      });
    } catch {
      setMessages((prev) => {
        const copy = [...prev];
        const idx = copy.findLastIndex((m) => m.loading);
        if (idx >= 0) copy[idx] = { role: "bot", text: "Sorry, I couldn't reach the assistant right now. Please try again." };
        return copy;
      });
    }
  }

  if (!open) return null;

  return (
    <section className={`ai-assistant-panel open ${isFullscreen ? "ai-assistant-fullscreen" : ""}`}>
      <header className="ai-assistant-header">
        <div className="ai-assistant-header-info">
          <div className="ai-assistant-avatar">🤖</div>
          <div>
            <div className="ai-assistant-title">AI Study Assistant</div>
            <div className="ai-assistant-subtitle">Always here to help you learn!</div>
          </div>
        </div>
        <div className="ai-assistant-header-actions">
          <button className="icon-button" type="button" aria-label="Toggle fullscreen"
            onClick={() => setIsFullscreen((v) => !v)} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {isFullscreen ? "⊡" : "⛶"}
          </button>
          <button className="icon-button close-btn" type="button" aria-label="Close AI assistant" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>
      <div className="ai-assistant-body">
        <div className="ai-messages" ref={messagesContainerRef}>
          {messages.map((m, idx) => (
            <div key={idx} className={`ai-message ${m.role === "user" ? "ai-message-user" : "ai-message-bot"} ${m.loading ? "ai-message-loading" : ""}`}>
              {m.role === "bot" && <div className="ai-message-icon">🤖</div>}
              <div className="ai-message-bubble">{m.text}</div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <form className="ai-input-row" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input type="text" className="ai-input" placeholder="Ask any study question..." value={input}
            onChange={(e) => setInput(e.target.value)} autoFocus />
          <button className="btn-primary ai-send-btn" type="submit" disabled={!input.trim()}>Send</button>
        </form>
      </div>
    </section>
  );
}

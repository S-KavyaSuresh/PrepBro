import React, { useEffect, useRef, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { recordActivity } from "../lib/tracker.js";

const RESULT_TABS = [
  { id: "simplified", label: "✏️ Simplified"  },
  { id: "keypoints",  label: "📌 Key Points"  },
  { id: "examples",   label: "💡 Examples"    },
  { id: "mindmap",    label: "🗺️ Mindmap"     },
  { id: "summary",    label: "📋 Summary"     },
  { id: "layman",     label: "🗣️ Layman"      },
  { id: "references", label: "🔗 References"  },
];

const HL_COLORS = [
  "#ffd16688", "#06d6a055", "#4f7cff33",
  "#f48fb155", "#a8e6cf66", "#ffaaa566",
];

// Word-by-word highlight for read-aloud
function HighlightedText({ text, activeWordIndex }) {
  const parts = (text || "").split(/(\s+)/);
  let wi = 0;
  return (
    <span>
      {parts.map((tok, i) => {
        if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
        const idx = wi++;
        return (
          <span key={i} className={`readable-word ${idx === activeWordIndex ? "word-highlight" : ""}`}>
            {tok}
          </span>
        );
      })}
    </span>
  );
}

// Converts **word** into coloured highlight spans
function renderHighlighted(text, isSpeaking, activeWordIndex) {
  if (!text) return null;
  const plain = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  if (isSpeaking) return <HighlightedText text={plain} activeWordIndex={activeWordIndex} />;

  let colorIdx = 0;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      const word = part.slice(2, -2);
      const bg = HL_COLORS[colorIdx % HL_COLORS.length];
      colorIdx++;
      return (
        <mark key={i} style={{ background: bg, borderRadius: "3px", padding: "1px 5px", fontWeight: 700, color: "inherit" }}>
          {word}
        </mark>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// Render simplified text: split on double-newlines → paragraphs
function SimplifiedView({ text, abbreviations, isSpeaking, activeWordIndex }) {
  if (!text) return null;
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

  return (
    <div className="simplified-view">
      {/* Abbreviations box */}
      {abbreviations && abbreviations.length > 0 && (
        <div className="abbr-box">
          <div className="abbr-box-title">📖 Abbreviations & Acronyms</div>
          <div className="abbr-grid">
            {abbreviations.map((a, i) => (
              <div key={i} className="abbr-item" style={{ borderLeftColor: HL_COLORS[i % HL_COLORS.length] }}>
                <span className="abbr-short">{a.short}</span>
                <span className="abbr-arrow">→</span>
                <span className="abbr-full">{a.full}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Colour-highlighted paragraphs */}
      <div className="simplified-paragraphs">
        {paragraphs.map((para, i) => (
          <p key={i} className="simplified-para">
            {renderHighlighted(para.trim(), isSpeaking, activeWordIndex)}
          </p>
        ))}
      </div>
    </div>
  );
}

// Reader-friendly bullet key points
function KeyPointsView({ points, isSpeaking, activeWordIndex }) {
  const ICONS  = ["🔵","🟢","🟡","🟠","🔴","🟣","🩵","⚪"];
  const COLORS = ["#4f7cff","#06d6a0","#ffd166","#ff9f40","#ff6b6b","#ce93d8","#4fc3f7","#90a4ae"];
  return (
    <ul className="keypoints-list">
      {(points || []).map((pt, i) => (
        <li key={i} className="keypoint-item" style={{ borderLeftColor: COLORS[i % COLORS.length] }}>
          <span className="kp-icon" style={{ color: COLORS[i % COLORS.length] }}>
            {ICONS[i % ICONS.length]}
          </span>
          <span className="kp-text">
            {isSpeaking
              ? <HighlightedText text={pt} activeWordIndex={activeWordIndex} />
              : pt}
          </span>
        </li>
      ))}
    </ul>
  );
}

// References panel
function ReferencesPanel({ topic, keywords }) {
  const [refs, setRefs]       = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, keywords: keywords || [] }),
      });
      setRefs(data);
    } catch { setRefs({ youtube: [], websites: [] }); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (topic || keywords?.length) load(); }, []);

  if (loading) return <div className="loading-msg">🔍 Finding the best resources…</div>;
  if (!refs)   return <button className="btn-primary" onClick={load}>🔗 Find Resources</button>;

  return (
    <div className="references-panel">
      {refs.youtube?.length > 0 && (
        <div className="refs-section">
          <h4 className="refs-heading">▶️ YouTube Videos</h4>
          <div className="refs-list">
            {refs.youtube.map((v, i) => (
              <a key={i} href={v.url} target="_blank" rel="noreferrer" className="ref-card ref-yt">
                <div className="ref-icon">▶</div>
                <div className="ref-info">
                  <div className="ref-title">{v.title}</div>
                  <div className="ref-channel">{v.channel}</div>
                  <div className="ref-desc">{v.desc}</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
      {refs.websites?.length > 0 && (
        <div className="refs-section">
          <h4 className="refs-heading">🌐 Websites</h4>
          <div className="refs-list">
            {refs.websites.map((w, i) => (
              <a key={i} href={w.url} target="_blank" rel="noreferrer" className="ref-card ref-web">
                <div className="ref-icon">🌐</div>
                <div className="ref-info">
                  <div className="ref-title">{w.title}</div>
                  <div className="ref-desc">{w.desc}</div>
                  <div className="ref-url">{w.url}</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Download helper ───────────────────────────────────────────────────────────
function buildDownloadText(result, inputText) {
  if (!result) return "";
  const lines = [];
  lines.push("═══════════════════════════════════════");
  lines.push("        PrepBro - Simplified Notes");
  lines.push("═══════════════════════════════════════");
  lines.push("");

  if (result.summary) {
    lines.push("📋 SUMMARY");
    lines.push("─────────────────────────────────────");
    lines.push(result.summary);
    lines.push("");
  }

  if (result.simplified) {
    lines.push("✏️ SIMPLIFIED TEXT");
    lines.push("─────────────────────────────────────");
    // Strip **markers** for plain text download
    lines.push(result.simplified.replace(/\*\*([^*]+)\*\*/g, "$1"));
    lines.push("");
  }

  if (result.keypoints?.length) {
    lines.push("📌 KEY POINTS");
    lines.push("─────────────────────────────────────");
    result.keypoints.forEach(pt => lines.push(`  • ${pt}`));
    lines.push("");
  }

  if (result.examples?.length) {
    lines.push("💡 EXAMPLES");
    lines.push("─────────────────────────────────────");
    result.examples.forEach((ex, i) => lines.push(`  ${i + 1}. ${ex}`));
    lines.push("");
  }

  if (result.layman) {
    lines.push("🗣️ IN SIMPLE WORDS (LAYMAN)");
    lines.push("─────────────────────────────────────");
    lines.push(result.layman);
    lines.push("");
  }

  if (result.abbreviations?.length) {
    lines.push("📖 ABBREVIATIONS");
    lines.push("─────────────────────────────────────");
    result.abbreviations.forEach(a => lines.push(`  ${a.short}  →  ${a.full}`));
    lines.push("");
  }

  lines.push("═══════════════════════════════════════");
  lines.push(`Generated by PrepBro  -  ${new Date().toLocaleDateString()}`);
  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

function downloadResult(result, inputText) {
  const content = buildDownloadText(result, inputText);
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "PrepBro_Simplified_Notes.txt";
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function SimplifyText() {
  const [mode,          setMode]          = useState("text");
  const [text,          setText]          = useState("");
  const [voiceText,     setVoiceText]     = useState("");
  const [fileText,      setFileText]      = useState("");
  const [fileName,      setFileName]      = useState("");
  const [activeResult,  setActiveResult]  = useState("simplified");
  const [result,        setResult]        = useState(null);
  const [busy,          setBusy]          = useState(false);
  const [mindmapSvg,    setMindmapSvg]    = useState(null);
  const [mindmapError,  setMindmapError]  = useState(null);
  const [mindmapFullscreen, setMindmapFullscreen] = useState(false);
  const [fileB64,       setFileB64]       = useState(null);
  const [isPdf,         setIsPdf]         = useState(false);
  const [isListening,   setIsListening]   = useState(false);
  const [isSpeaking,    setIsSpeaking]    = useState(false);
  const [activeWordIdx, setActiveWordIdx] = useState(-1);
  const recognitionRef  = useRef(null);

  const inputText = useMemo(() => {
    if (mode === "text")     return text;
    if (mode === "voice")    return voiceText;
    return fileText;
  }, [mode, text, voiceText, fileText]);

  useEffect(() => { setMindmapSvg(null); setMindmapError(null); }, [result?.mindmap]);

  const emitToast = (msg, type = "error") => {
    window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg, type } }));
  };

  // ── Voice input ──
  const startVoice = () => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      emitToast("Voice input requires Chrome.", "error"); return;
    }
    const SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = e => setVoiceText(Array.from(e.results).map(r => r[0].transcript).join(" "));
    rec.onend    = () => setIsListening(false);
    rec.start(); recognitionRef.current = rec; setIsListening(true);
  };
  const stopVoice = () => { recognitionRef.current?.stop(); setIsListening(false); };

  // ── File upload ──
  async function onUpload(file) {
    if (!file) return;
    setFileName(file.name);
    setIsPdf(file.type === "application/pdf" || file.name.endsWith(".pdf"));
    if (file.type === "text/plain" || file.name.endsWith(".txt")) {
      const t = await file.text();
      setFileText(t);
      setFileB64(btoa(unescape(encodeURIComponent(t))));
      return;
    }
    // Read as base64 then send as JSON — avoids multipart/python-multipart issues
    const reader = new FileReader();
    reader.onload = async (e) => {
      const b64 = e.target.result.split(",")[1];
      setFileB64(b64);
      try {
        const data = await apiFetch("/api/extract-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_b64: b64, filename: file.name }),
        });
        setFileText(data.text || "");
      } catch (err) { window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg: "File extraction failed: " + (err.message || "Unknown error") + ". Make sure the backend is running.", type: "error" } })); }
    };
    reader.onerror = () => emitToast("Could not read file.", "error");
    reader.readAsDataURL(file);
  }

  // ── Simplify ──
  async function simplify() {
    const trimmed = inputText.trim();
    if (!trimmed) { emitToast("Please enter, speak, or upload text first.", "error"); return; }
    setBusy(true); setResult(null); setMindmapSvg(null); setMindmapError(null); stopReading();
    try {
      const data = await apiFetch("/api/simplify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: trimmed, mode,
          is_pdf: mode === "document" && isPdf,
          file_b64: mode === "document" ? fileB64 : null,
        }),
      });
      setResult(data); setActiveResult("simplified");
      recordActivity("simplify");
    } catch (e) { window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg: "Could not simplify: " + (e.message || "Make sure the backend is running."), type: "error" } })); }
    finally { setBusy(false); }
  }

  // ── Read aloud ──
  function getReadText() {
    if (!result) return "";
    const plain = t => (t || "").replace(/\*\*([^*]+)\*\*/g, "$1");
    if (activeResult === "simplified") return plain(result.simplified);
    if (activeResult === "keypoints")  return (result.keypoints || []).join(". ");
    if (activeResult === "examples")   return (result.examples  || []).join(". ");
    if (activeResult === "summary")    return plain(result.summary);
    if (activeResult === "layman")     return plain(result.layman);
    return "";
  }

  function readAloud() {
    const toSpeak = getReadText(); if (!toSpeak) return;
    window.speechSynthesis.cancel(); setActiveWordIdx(-1);
    const u = new SpeechSynthesisUtterance(toSpeak);
    u.rate = 0.85; u.pitch = 1.05;
    u.onboundary = e => {
      if (e.name === "word") {
        const spoken = toSpeak.substring(0, e.charIndex);
        setActiveWordIdx(spoken.split(/\s+/).filter(Boolean).length);
      }
    };
    u.onstart = () => setIsSpeaking(true);
    u.onend   = () => { setIsSpeaking(false); setActiveWordIdx(-1); };
    u.onerror = () => { setIsSpeaking(false); setActiveWordIdx(-1); };
    window.speechSynthesis.speak(u);
  }

  function stopReading() {
    window.speechSynthesis.cancel(); setIsSpeaking(false); setActiveWordIdx(-1);
  }


  // ── Mindmap ──
  async function renderMindmap() {
    if (!result?.mindmap) return;
    setMindmapSvg(null); setMindmapError(null);
    try {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
      let mm = result.mindmap.trim().replace(/```mermaid/g,"").replace(/```/g,"").trim();
      if (!mm.startsWith("mindmap")) mm = "mindmap\n" + mm;
      const { svg } = await mermaid.render(`mm${Date.now()}`, mm);
      setMindmapSvg(svg);
    } catch {
      try {
        const topics = result.keypoints?.slice(0, 5) || [];
        const fb = `mindmap\n  root((Topic))\n${topics.map(t=>`    ${t.substring(0,30).replace(/[()[\]{}]/g,"")}`).join("\n")}`;
        const mermaid2 = (await import("mermaid")).default;
        const { svg } = await mermaid2.render(`mm2${Date.now()}`, fb);
        setMindmapSvg(svg);
      } catch { setMindmapError("Could not render mindmap."); }
    }
  }

  useEffect(() => {
    if (activeResult === "mindmap" && result?.mindmap) renderMindmap();
  }, [activeResult, result?.mindmap]);

  const canReadAloud = ["simplified","keypoints","examples","summary","layman"].includes(activeResult);

  return (
    <div className="simplify-page">
      <div className="page-header">
        <h2 className="card-title">✏️ Simplify Text</h2>
        <p className="card-subtitle">Make any text easier to read and understand.</p>
      </div>

      {/* Input mode selector */}
      <div className="chip-row">
        {[["text","📝 Enter Text"],["voice","🎤 Voice"],["document","📄 Upload"]].map(([m,l]) => (
          <button key={m} className={`chip ${mode === m ? "chip-primary" : ""}`} type="button"
            onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>

      {mode === "text" && (
        <textarea className="text-area" rows={6} value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Type or paste your study text here…" />
      )}
      {mode === "voice" && (
        <div className="voice-input-area">
          <div className="voice-controls">
            {!isListening
              ? <button className="btn-primary" onClick={startVoice}>🎤 Start Speaking</button>
              : <button className="btn-secondary" onClick={stopVoice}>⏹ Stop</button>}
            {isListening && <div className="voice-pulse">🔴 Listening…</div>}
          </div>
          <textarea className="text-area" rows={5} value={voiceText}
            onChange={e => setVoiceText(e.target.value)}
            placeholder="Spoken words appear here…" />
        </div>
      )}
      {mode === "document" && (
        <div className="upload-area">
          <label className="upload-zone" htmlFor="simplify-upload">
            <span className="upload-icon">📁</span>
            <span>{fileName ? `📄 ${fileName}` : "Click to upload .txt, .pdf, or .docx"}</span>
          </label>
          <input id="simplify-upload" type="file" accept=".txt,.pdf,.docx" hidden
            onChange={e => onUpload(e.target.files?.[0])} />
          {fileText && (
            <textarea className="text-area" rows={5} value={fileText}
              onChange={e => setFileText(e.target.value)}
              placeholder="Extracted text preview…" />
          )}
        </div>
      )}

      {/* Action row */}
      <div className="actions-row" style={{ flexWrap: "wrap", gap: 10 }}>
        <button className="btn-primary btn-large" onClick={simplify} disabled={busy}>
          {busy ? "⏳ Simplifying…" : "✨ Simplify Text"}
        </button>
        {result && canReadAloud && (
          isSpeaking
            ? <button className="btn-ghost" onClick={stopReading}>⏹ Stop Reading</button>
            : <button className="btn-ghost" onClick={readAloud}>🔊 Read Aloud</button>
        )}
        {result && (
          <button className="btn-ghost download-btn" onClick={() => downloadResult(result, inputText)}>
            ⬇️ Download Notes
          </button>
        )}
      </div>

      {busy && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
          <p>AI is simplifying your text…</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="simplify-results">
          <div className="simplify-tabs">
            {RESULT_TABS.map(t => (
              <button key={t.id}
                className={`simplify-tab ${activeResult === t.id ? "simplify-tab-active" : ""}`}
                onClick={() => { setActiveResult(t.id); stopReading(); }}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="simplify-result-content">

            {activeResult === "simplified" && (
              <SimplifiedView
                text={result.simplified}
                abbreviations={result.abbreviations}
                isSpeaking={isSpeaking}
                activeWordIndex={activeWordIdx}
              />
            )}

            {activeResult === "keypoints" && (
              <KeyPointsView
                points={result.keypoints}
                isSpeaking={isSpeaking}
                activeWordIndex={activeWordIdx}
              />
            )}

            {activeResult === "examples" && (
              <ol className="examples-list">
                {(result.examples || []).map((ex, i) => (
                  <li key={i} className="example-item">
                    <span className="example-num">{i + 1}</span>
                    <span>{isSpeaking
                      ? <HighlightedText text={ex} activeWordIndex={activeWordIdx} />
                      : ex}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {activeResult === "summary" && (
              <div className="summary-card">
                <div className="summary-icon">📋</div>
                <div className="summary-text">
                  {result.summary?.split(/\n+/).map((line, i) => (
                    <p key={i}>{isSpeaking
                      ? <HighlightedText text={line} activeWordIndex={activeWordIdx} />
                      : renderHighlighted(line, false, -1)}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {activeResult === "layman" && (
              <div className="layman-card">
                <div className="layman-icon">🗣️</div>
                <div className="layman-text">
                  {result.layman?.split(/\n+/).map((line, i) => (
                    <p key={i}>{isSpeaking
                      ? <HighlightedText text={line} activeWordIndex={activeWordIdx} />
                      : renderHighlighted(line, false, -1)}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {activeResult === "mindmap" && (
              <div className="mindmap-wrap">
                {!mindmapSvg && !mindmapError && <div className="loading-msg">🗺️ Rendering mindmap…</div>}
                {mindmapError && (
                  <div>
                    <div className="error-msg">{mindmapError}</div>
                    <ul className="keypoints-list">{(result.keypoints||[]).map((k,i)=><li key={i}>{k}</li>)}</ul>
                  </div>
                )}
                {mindmapSvg && (
                  <>
                    <div className="mindmap-toolbar">
                      <button className="mindmap-fullscreen-btn" onClick={() => setMindmapFullscreen(true)}>
                        ⛶ Full Screen
                      </button>
                    </div>
                    <div className="mindmap-svg" dangerouslySetInnerHTML={{ __html: mindmapSvg }} />
                  </>
                )}
              </div>
            )}
            {mindmapFullscreen && mindmapSvg && (
              <div className="mindmap-overlay" onClick={(e) => { if (e.target === e.currentTarget) setMindmapFullscreen(false); }}>
                <div className="mindmap-overlay-inner">
                  <button className="mindmap-overlay-close" onClick={() => setMindmapFullscreen(false)}>✕ Close</button>
                  <div dangerouslySetInnerHTML={{ __html: mindmapSvg }} />
                </div>
              </div>
            )}

            {activeResult === "references" && (
              <ReferencesPanel
                topic={inputText.substring(0, 200)}
                keywords={result.keypoints?.slice(0, 5)}
              />
            )}


          </div>
        </div>
      )}

      {!result && !busy && (
        <div className="empty-state">
          <div className="empty-icon">📚</div>
          <p>Your simplified results will appear here after clicking "Simplify Text".</p>
        </div>
      )}
    </div>
  );
}


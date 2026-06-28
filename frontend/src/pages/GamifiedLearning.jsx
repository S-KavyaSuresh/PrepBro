import React, { useRef, useState } from "react";

import { apiFetch } from "../lib/api.js";
import { recordActivity } from "../lib/tracker.js";

function emitToast(msg, type = "error") {
  window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg, type } }));
}

function HighlightedText({ text, activeWordIndex }) {
  const words = (text || "").split(/(\s+)/);
  let wordIdx = 0;
  return (
    <span>
      {words.map((token, i) => {
        if (/^\s+$/.test(token)) return <span key={i}>{token}</span>;
        const idx = wordIdx++;
        return (
          <span key={i} className={`readable-word ${idx === activeWordIndex ? "word-highlight" : ""}`}>{token}</span>
        );
      })}
    </span>
  );
}

export default function GamifiedLearning() {
  const [mode, setMode] = useState("text");
  const [text, setText] = useState("");
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [quizCount, setQuizCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [usedQuestions, setUsedQuestions] = useState([]);
  const [currentSet, setCurrentSet] = useState([]);
  const [idx, setIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [totalScore, setTotalScore] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [answered, setAnswered] = useState(false);
  const [phase, setPhase] = useState("setup");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [showNextPrompt, setShowNextPrompt] = useState(false);
  const quizStartedAtRef = useRef(null);

  async function onUpload(file) {
    if (!file) return;
    setFileName(file.name);
    if (file.type === "text/plain" || file.name.endsWith(".txt")) {
      setFileText(await file.text());
      return;
    }
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const data = await apiFetch("/api/extract-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_b64: b64, filename: file.name }),
      });
      setFileText(data.text || "");
    } catch (err) {
      emitToast(`Extraction failed: ${err.message || "Make sure the backend is running."}`, "error");
    }
  }

  async function generate(isMore = false) {
    const src = (mode === "text" ? text : fileText).trim();
    if (!src) {
      emitToast("Please add study text first.", "error");
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: src,
          count: Number(quizCount) || 6,
          exclude: isMore ? usedQuestions.map((q) => q.question) : [],
        }),
      });
      const qs = Array.isArray(data.questions) ? data.questions : [];
      if (!isMore) {
        setUsedQuestions(qs);
        setCurrentSet(qs);
        setScore(0);
        setTotalScore(0);
      } else {
        setUsedQuestions((prev) => [...prev, ...qs]);
        setCurrentSet(qs);
        setScore(0);
      }
      setIdx(0);
      setFeedback("");
      setAnswered(false);
      setPhase("quiz");
      setShowNextPrompt(false);
      quizStartedAtRef.current = Date.now();
    } catch (e) {
      emitToast(`Quiz generation failed: ${e.message || "Make sure the backend is running."}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function finishQuizRound() {
    const startedAt = quizStartedAtRef.current;
    if (startedAt) {
      const elapsedMs = Date.now() - startedAt;
      const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60000));
      recordActivity("session_complete", {
        minutes: elapsedMinutes,
        subject: "Gamified Learning",
      });
      quizStartedAtRef.current = null;
    }
    setPhase("done");
    setShowNextPrompt(true);
  }

  function answer(choiceIndex) {
    if (answered) return;
    const q = currentSet[idx];
    if (!q) return;
    setAnswered(true);
    stopReading();
    const correct = Number(q.answerIndex);
    if (choiceIndex === correct) {
      setScore((s) => s + 10);
      setTotalScore((s) => s + 10);
      setFeedback(`Correct! ${q.explanation || ""}`);
    } else {
      setFeedback(`Not quite. The answer is "${q.choices?.[correct]}". ${q.explanation || ""}`);
    }
    recordActivity("quiz");
    setTimeout(() => {
      setFeedback("");
      setAnswered(false);
      if (idx < currentSet.length - 1) {
        setIdx((i) => i + 1);
      } else {
        finishQuizRound();
      }
    }, 2200);
  }

  function readQuestion() {
    const q = currentSet[idx];
    if (!q) return;
    window.speechSynthesis.cancel();
    const choiceLetters = ["A", "B", "C", "D"];
    const fullText = `${q.question}. The provided options are: ${q.choices.map((c, i) => `${choiceLetters[i]}. ${c}`).join(". ")}`;
    const utterance = new SpeechSynthesisUtterance(fullText);
    utterance.rate = 0.88;
    utterance.pitch = 1.05;
    utterance.onboundary = (e) => {
      if (e.name === "word") {
        const spoken = fullText.substring(0, e.charIndex);
        setActiveWordIndex(spoken.split(/\s+/).filter(Boolean).length);
      }
    };
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      setActiveWordIndex(-1);
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setActiveWordIndex(-1);
    };
    window.speechSynthesis.speak(utterance);
  }

  function stopReading() {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setActiveWordIndex(-1);
  }

  const q = currentSet[idx];

  return (
    <div className="gamified-page">
      <div className="page-header">
        <h2 className="card-title">Gamified Learning</h2>
        <p className="card-subtitle">Turn your notes into quizzes and earn points.</p>
      </div>

      {phase === "setup" && (
        <div>
          <div className="chip-row">
            <button className={`chip ${mode === "text" ? "chip-primary" : ""}`} type="button" onClick={() => setMode("text")}>Paste Text</button>
            <button className={`chip ${mode === "upload" ? "chip-primary" : ""}`} type="button" onClick={() => setMode("upload")}>Upload Document</button>
          </div>

          {mode === "text" && (
            <textarea
              className="text-area"
              rows={7}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your study notes here. AI will create quiz questions from them."
            />
          )}

          {mode === "upload" && (
            <div className="upload-area">
              <label className="upload-zone upload-zone-large" htmlFor="quiz-upload">
                <span className="upload-zone-inner">
                  <span className="upload-icon upload-folder-icon" aria-hidden="true">📁</span>
                  <span className="upload-zone-text">Click to upload .txt, .pdf, or .docx</span>
                  {fileName && <span className="upload-zone-file">{fileName}</span>}
                </span>
              </label>
              <input id="quiz-upload" type="file" hidden accept=".txt,.pdf,.docx" onChange={(e) => onUpload(e.target.files?.[0])} />
              {fileText && <div className="file-preview">{fileText.length} characters loaded</div>}
            </div>
          )}

          <div className="quiz-count-row">
            <label className="settings-label" htmlFor="quizCount">Number of questions: <strong>{quizCount}</strong></label>
            <div className="quiz-count-controls">
              <input
                id="quizCount"
                type="range"
                min="3"
                max="15"
                value={quizCount}
                className="settings-range"
                onChange={(e) => setQuizCount(Number(e.target.value))}
              />
              <span className="quiz-count-value">{quizCount} questions</span>
            </div>
          </div>

          <button className="btn-primary btn-large" type="button" onClick={() => generate(false)} disabled={busy}>
            {busy ? "Generating..." : "Generate Quiz"}
          </button>
        </div>
      )}

      {phase === "quiz" && q && (
        <div className="quiz-container">
          <div className="quiz-progress">
            <div className="quiz-progress-bar">
              <div className="quiz-progress-fill" style={{ width: `${((idx + 1) / currentSet.length) * 100}%` }}></div>
            </div>
            <div className="quiz-progress-text">Question {idx + 1} of {currentSet.length}</div>
          </div>

          <div className="quiz-top-row">
            <div className="quiz-score">Score: {totalScore}</div>
            <div className="quiz-read-btn">
              {isSpeaking
                ? <button className="btn-ghost btn-sm" type="button" onClick={stopReading}>⏹ Stop</button>
                : <button className="btn-ghost btn-sm" type="button" onClick={readQuestion}>🔊 Read Aloud</button>}
            </div>
          </div>

          <div className="quiz-question">
            <div className="quiz-question-text">
              {isSpeaking ? <HighlightedText text={q.question} activeWordIndex={activeWordIndex} /> : q.question}
            </div>
          </div>

          {isSpeaking && (
            <div className="options-label">The provided options are:</div>
          )}

          <div className="quiz-choices">
            {(q.choices || []).map((choice, i) => (
              <button
                key={i}
                className={`quiz-choice ${answered && i === Number(q.answerIndex) ? "quiz-choice-correct" : ""} ${answered && i !== Number(q.answerIndex) ? "quiz-choice-wrong" : ""}`}
                type="button"
                onClick={() => answer(i)}
                disabled={answered}
              >
                <span className="choice-letter">{["A", "B", "C", "D"][i]}</span>
                <span>{choice}</span>
              </button>
            ))}
          </div>

          {feedback && (
            <div className={`quiz-feedback ${feedback.startsWith("Correct!") ? "feedback-correct" : "feedback-wrong"}`}>
              {feedback}
            </div>
          )}
        </div>
      )}

      {phase === "done" && (
        <div className="quiz-done">
          <div className="quiz-done-trophy quiz-done-celebration">Done 🎉</div>
          <h3>Level Complete!</h3>
          <div className="quiz-done-score">You scored <strong>{score}</strong> points this round.</div>
          <div className="quiz-done-total">Total: <strong>{totalScore}</strong> points earned.</div>
          {showNextPrompt && (
            <p style={{ color: "var(--color-text-muted)", marginTop: 8 }}>
              Do you want to load the next set of {quizCount} questions?
            </p>
          )}
          <div className="actions-row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn-primary" type="button" onClick={() => generate(true)} disabled={busy}>
              {busy ? "Loading..." : "Load Next Set"}
            </button>
            <button className="btn-ghost" type="button" onClick={() => { setPhase("setup"); setShowNextPrompt(false); }}>
              Back
            </button>
            <button className="btn-ghost" type="button" onClick={() => { setPhase("setup"); setUsedQuestions([]); setTotalScore(0); setShowNextPrompt(false); }}>
              New Topic
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


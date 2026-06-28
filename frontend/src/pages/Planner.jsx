import React, { useState, useEffect, useRef } from "react";
import { apiFetch } from "../lib/api.js";
import { recordActivity } from "../lib/tracker.js";

function formatTime(secs) {
  const m = Math.floor(Math.abs(secs) / 60).toString().padStart(2, "0");
  const s = (Math.abs(secs) % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function parseDurationToSecs(dur) {
  if (!dur) return 25 * 60;
  const m = dur.toString().match(/(\d+)/);
  return m ? parseInt(m[1]) * 60 : 25 * 60;
}

const POMODORO_SECS = 25 * 60;
const DAYS_OPTIONS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function Planner() {
  // Setup state
  const [step, setStep] = useState(1);
  const [subjects, setSubjects] = useState("");
  const [hoursPerDay, setHoursPerDay] = useState(2);
  const [priority, setPriority] = useState("");
  const [studyDays, setStudyDays] = useState(["Mon","Tue","Wed","Thu","Fri"]);
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState([]);
  const [completedSessions, setCompletedSessions] = useState(new Set());
  const [points, setPoints] = useState(0);

  // Edit state
  const [editMode, setEditMode] = useState(false); // false | "session" | "subjects"
  const [editDayIdx, setEditDayIdx] = useState(null);
  const [editSessIdx, setEditSessIdx] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSubjects, setEditSubjects] = useState("");

  // Timer state — schedule-based
  const [timerQueue, setTimerQueue] = useState([]); // flat ordered list of sessions
  const [timerQueueIdx, setTimerQueueIdx] = useState(0);
  const [schedTimeLeft, setSchedTimeLeft] = useState(0);
  const [schedRunning, setSchedRunning] = useState(false);
  const schedTimerRef = useRef(null);

  // Pomodoro timer (independent)
  const [pomodoroLeft, setPomodoroLeft] = useState(POMODORO_SECS);
  const [pomodoroRunning, setPomodoroRunning] = useState(false);
  const [pomodoroMode, setPomodoroMode] = useState("work"); // work | break
  const pomTimerRef = useRef(null);

  // Focus mode
  const [focusMode, setFocusMode] = useState(null); // null | "schedule" | "pomodoro"
  const [showDonePrompt, setShowDonePrompt] = useState(false);
  const [timesUpNotif, setTimesUpNotif] = useState(false);

  // Revision plan state
  const [showRevisionSetup, setShowRevisionSetup] = useState(false);
  const [revisionDays, setRevisionDays] = useState(3);
  const [revisionHours, setRevisionHours] = useState(1.5);
  const [revisionStudyDays, setRevisionStudyDays] = useState(["Mon","Tue","Wed","Thu","Fri"]);
  const [busyRevision, setBusyRevision] = useState(false);
  const [revisionSchedule, setRevisionSchedule] = useState(null);

  const toggleDay = (d) => setStudyDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  // ---- File upload ----
  const handleFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setFileName(file.name); setBusy(true);
    try {
      if (file.type === "text/plain" || file.name.endsWith(".txt")) {
        setFileText(await file.text());
        setBusy(false);
        return;
      }
      // Read as base64, send as JSON — avoids multipart/python-multipart issues
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
    } catch (err) { window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg: "Extraction failed: " + (err.message || "Make sure the backend is running."), type: "error" } })); } finally { setBusy(false); }
  };

  // ---- Create plan ----
  const handleCreate = async () => {
    const subjs = subjects.split(",").map(s => s.trim()).filter(Boolean);
    if (subjs.length === 0 && !fileText.trim()) { emitToast("Please enter subjects or upload a document.", "error"); return; }
    setBusy(true);
    try {
      const data = await apiFetch("/api/smart-schedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjects: subjs, hours_per_day: Number(hoursPerDay),
          priority_subjects: priority.split(",").map(s => s.trim()).filter(Boolean),
          study_days: studyDays, document_text: fileText,
        }),
      });
      if (data.schedule?.length > 0) {
        setSchedule(data.schedule);
        setCompletedSessions(new Set());
        buildTimerQueue(data.schedule);
        setStep(2);
      } else { emitToast("Could not generate a schedule. Please add more detail.", "error"); }
    } catch (e) { window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg: "Could not create schedule: " + (e.message || "Make sure the backend is running."), type: "error" } })); }
    finally { setBusy(false); }
  };

  // Build flat timer queue from schedule
  const buildTimerQueue = (sched) => {
    const queue = [];
    sched.forEach((day, dIdx) => {
      (day.sessions || []).forEach((s, sIdx) => {
        queue.push({ ...s, dayIdx: dIdx, sessIdx: sIdx, key: `${dIdx}-${sIdx}` });
      });
    });
    setTimerQueue(queue);
    setTimerQueueIdx(0);
    if (queue.length > 0) setSchedTimeLeft(parseDurationToSecs(queue[0].duration));
  };

  // Schedule timer tick
  useEffect(() => {
    if (schedRunning && schedTimeLeft > 0) {
      schedTimerRef.current = setInterval(() => setSchedTimeLeft(t => t - 1), 1000);
    } else if (schedRunning && schedTimeLeft === 0) {
      clearInterval(schedTimerRef.current);
      setSchedRunning(false);
      setTimesUpNotif(true);
      setShowDonePrompt(true);
    }
    return () => clearInterval(schedTimerRef.current);
  }, [schedRunning, schedTimeLeft]);

  // Pomodoro timer tick
  useEffect(() => {
    if (pomodoroRunning && pomodoroLeft > 0) {
      pomTimerRef.current = setInterval(() => setPomodoroLeft(t => t - 1), 1000);
    } else if (pomodoroRunning && pomodoroLeft === 0) {
      clearInterval(pomTimerRef.current);
      setPomodoroRunning(false);
      if (pomodoroMode === "work") { setPomodoroMode("break"); setPomodoroLeft(5 * 60); }
      else { setPomodoroMode("work"); setPomodoroLeft(POMODORO_SECS); }
      setTimesUpNotif(true);
    }
    return () => clearInterval(pomTimerRef.current);
  }, [pomodoroRunning, pomodoroLeft, pomodoroMode]);

  const currentQueued = timerQueue[timerQueueIdx] || null;

  const advanceQueue = () => {
    const next = timerQueueIdx + 1;
    if (next < timerQueue.length) {
      setTimerQueueIdx(next);
      setSchedTimeLeft(parseDurationToSecs(timerQueue[next].duration));
      setTimesUpNotif(false);
      setShowDonePrompt(false);
    } else {
      // All sessions complete — reset timer display, exit focus if active
      setTimerQueueIdx(timerQueue.length); // beyond last
      setSchedTimeLeft(0);
      setSchedRunning(false);
      setTimesUpNotif(false);
      setShowDonePrompt(false);
      setFocusMode(null);
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const markSessionDone = () => {
    if (currentQueued) {
      setCompletedSessions(prev => { const s = new Set(prev); s.add(currentQueued.key); return s; });
      setPoints(p => p + 25);
      // Record in tracker so dashboard sessions count updates
      const mins = Math.round(parseDurationToSecs(currentQueued.duration) / 60) || 25;
      recordActivity("session_complete", { minutes: mins, subject: currentQueued.subject });
    }
    // Stop the running timer before advancing
    setSchedRunning(false);
    clearInterval(schedTimerRef.current);
    advanceQueue();
  };

  const enterFocusMode = (type) => {
    setFocusMode(type);
    setTimesUpNotif(false);
    setShowDonePrompt(false);
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const exitFocusMode = () => {
    setFocusMode(null);
    setSchedRunning(false);
    setPomodoroRunning(false);
    setTimesUpNotif(false);
    setShowDonePrompt(false);
    document.exitFullscreen?.().catch(() => {});
  };

  // ---- Edit ----
  const openEditSession = (dIdx, sIdx) => {
    const s = schedule[dIdx].sessions[sIdx];
    setEditForm({ subject: s.subject, startTime: s.startTime, duration: s.duration, type: s.type || "study" });
    setEditDayIdx(dIdx); setEditSessIdx(sIdx);
    setEditMode("session");
  };

  const saveEditSession = () => {
    setSchedule(prev => {
      const next = prev.map((day, di) => di !== editDayIdx ? day : {
        ...day,
        sessions: day.sessions.map((s, si) => si !== editSessIdx ? s : { ...s, ...editForm })
      });
      return next;
    });
    setEditMode(false);
  };

  const deleteSession = (dIdx, sIdx) => {
    setSchedule(prev => {
      const next = prev.map((d, di) => di !== dIdx ? d : {
        ...d, sessions: d.sessions.filter((_, si) => si !== sIdx)
      });
      return next.filter(d => d.sessions.length > 0);
    });
  };

  const openEditSubjects = () => {
    const allSubjs = [...new Set(
      schedule.flatMap(d => d.sessions.filter(s => s.type !== "break").map(s => s.subject))
    )].join(", ");
    setEditSubjects(allSubjs);
    setEditMode("subjects");
  };

  const saveEditSubjects = () => {
    const newSubjs = editSubjects.split(",").map(s => s.trim()).filter(Boolean);
    if (newSubjs.length === 0) { emitToast("Please enter at least one subject.", "error"); return; }
    // Re-create by replacing study sessions while keeping breaks structure
    setSchedule(prev => {
      let subjectCycle = 0;
      return prev.map(day => ({
        ...day,
        sessions: day.sessions.map(s => {
          if (s.type === "break") return s;
          const newSubj = newSubjs[subjectCycle % newSubjs.length];
          subjectCycle++;
          return { ...s, subject: newSubj };
        })
      }));
    });
    setEditMode(false);
  };

  // ---- Revision Plan ----
  const createRevisionPlan = async () => {
    if (!schedule || schedule.length === 0) return;
    setBusyRevision(true);
    try {
      const { apiFetch } = await import("../lib/api.js");
      const effectiveDays = revisionStudyDays.length > 0 ? revisionStudyDays : ["Mon","Tue","Wed"];
      const data = await apiFetch("/api/revision-schedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          original_schedule: schedule,
          revision_days: effectiveDays.length,
          hours_per_day: revisionHours,
          study_days: effectiveDays,
        }),
      });
      if (data.schedule?.length > 0) {
        setRevisionSchedule(data.schedule);
        setShowRevisionSetup(false);
      } else { emitToast("Could not create revision plan. Please try again.", "error"); }
    } catch (e) { emitToast("Error: " + (e.message || "Unknown"), "error"); }
    finally { setBusyRevision(false); }
  };

  // ---- Focus Mode UI ----
  if (focusMode) {
    const isSchedFocus = focusMode === "schedule";
    const timeLeft = isSchedFocus ? schedTimeLeft : pomodoroLeft;
    const running = isSchedFocus ? schedRunning : pomodoroRunning;
    const setRunning = isSchedFocus ? setSchedRunning : setPomodoroRunning;
    const currentName = isSchedFocus
      ? (currentQueued?.type === "break" ? "☕ Break Time" : `📖 ${currentQueued?.subject || "Study"}`)
      : (pomodoroMode === "work" ? "🎯 Pomodoro Focus" : "☕ Pomodoro Break");

    return (
      <div className="focus-overlay">
        <div className="focus-content">
          <div className="focus-type-badge">{isSchedFocus ? "📅 Schedule Timer" : "⏱️ Pomodoro Timer"}</div>
          <div className="focus-subject">{currentName}</div>
          <div className={`focus-timer ${(isSchedFocus ? currentQueued?.type === "break" : pomodoroMode === "break") ? "focus-timer-break" : ""}`}>
            {formatTime(timeLeft)}
          </div>

          {timesUpNotif && (
            <div className="focus-times-up">
              ⏰ Time is up!
              {isSchedFocus && showDonePrompt && (
                <div className="focus-complete-actions" style={{ marginTop: 12 }}>
                  <button className="focus-btn focus-complete" onClick={markSessionDone}>✅ Done — Next Session</button>
                  <button className="focus-btn focus-pause" onClick={() => { setSchedTimeLeft(parseDurationToSecs(currentQueued?.duration)); setTimesUpNotif(false); setShowDonePrompt(false); }}>🔄 Restart</button>
                </div>
              )}
            </div>
          )}

          {!timesUpNotif && (
            <div className="focus-actions">
              {!running
                ? <button className="focus-btn focus-start" onClick={() => setRunning(true)}>▶ Start</button>
                : <button className="focus-btn focus-pause" onClick={() => setRunning(false)}>⏸ Pause</button>}
              {isSchedFocus && currentQueued && (
                <button className="focus-btn focus-complete" onClick={markSessionDone}>✅ Mark Done</button>
              )}
              <button className="focus-btn focus-stop" onClick={exitFocusMode}>✕ Exit</button>
            </div>
          )}

          {isSchedFocus && timerQueue.length > 0 && (
            <div className="focus-queue">
              <div className="focus-queue-label">Session {timerQueueIdx + 1} of {timerQueue.length}</div>
              {timerQueue.slice(timerQueueIdx, timerQueueIdx + 3).map((s, i) => (
                <div key={i} className={`focus-queue-item ${i === 0 ? "focus-queue-current" : "focus-queue-next"}`}>
                  {i === 0 ? "▶ " : "○ "}{s.type === "break" ? "☕ Break" : s.subject} — {s.duration}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Edit Session Modal ----
  if (editMode === "session") {
    return (
      <div className="edit-modal-overlay">
        <div className="edit-modal">
          <h3 className="edit-modal-title">✏️ Edit Session</h3>
          {["subject","startTime","duration"].map(field => (
            <div key={field} className="settings-group">
              <label className="settings-label">{field === "startTime" ? "Start Time" : field === "duration" ? "Duration (e.g. 30 min)" : "Subject"}</label>
              <input className="settings-select" value={editForm[field] || ""}
                onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value }))} />
            </div>
          ))}
          <div className="settings-group">
            <label className="settings-label">Type</label>
            <select className="settings-select" value={editForm.type || "study"} onChange={e => setEditForm(f => ({ ...f, type: e.target.value }))}>
              <option value="study">📖 Study</option>
              <option value="break">☕ Break</option>
            </select>
          </div>
          <div className="actions-row">
            <button className="btn-primary" onClick={saveEditSession}>💾 Save</button>
            <button className="btn-ghost" onClick={() => setEditMode(false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  if (editMode === "subjects") {
    return (
      <div className="edit-modal-overlay">
        <div className="edit-modal">
          <h3 className="edit-modal-title">📚 Edit Subjects</h3>
          <p className="card-subtitle">Change the subjects in your schedule. Separate with commas.</p>
          <textarea className="text-area" rows={3} value={editSubjects}
            onChange={e => setEditSubjects(e.target.value)}
            placeholder="Math, Science, English..." />
          <div className="actions-row">
            <button className="btn-primary" onClick={saveEditSubjects}>💾 Update Schedule</button>
            <button className="btn-ghost" onClick={() => setEditMode(false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Main UI ----
  return (
    <>
    <div className="planner-page">
      <div className="page-header">
        <h2 className="card-title">📅 Smart Schedule Planner</h2>
        <p className="card-subtitle">AI-powered study planner — smart, balanced, and built for you!</p>
      </div>

      {step === 1 && (
        <div className="planner-setup">
          <div className="planner-setup-grid">
            <div className="settings-group">
              <label className="settings-label">📚 Subjects to study</label>
              <textarea className="text-area" rows={3} value={subjects}
                onChange={e => setSubjects(e.target.value)} placeholder="Math, Science, English, History..." />
            </div>
            <div className="settings-group">
              <label className="settings-label">⭐ Priority subjects (optional)</label>
              <input className="settings-select" value={priority}
                onChange={e => setPriority(e.target.value)} placeholder="Math, Science (most important first)" />
            </div>
            <div className="settings-group">
              <label className="settings-label">⏰ Hours per day: <strong>{hoursPerDay}h</strong></label>
              <input type="range" min="1" max="8" value={hoursPerDay} className="settings-range"
                onChange={e => setHoursPerDay(Number(e.target.value))} />
            </div>
            <div className="settings-group">
              <label className="settings-label">📆 Study days</label>
              <div className="day-selector">
                {DAYS_OPTIONS.map(d => (
                  <button key={d} type="button" className={`day-btn ${studyDays.includes(d) ? "day-btn-active" : ""}`}
                    onClick={() => toggleDay(d)}>{d}</button>
                ))}
              </div>
            </div>
            <div className="settings-group">
              <label className="settings-label">📄 OR Upload a study document</label>
              <label className="upload-zone" htmlFor="planner-upload">
                <span className="upload-icon">📁</span>
                <span>{fileName ? `✅ ${fileName}` : "Click to upload .txt, .pdf, or .docx"}</span>
              </label>
              <input type="file" id="planner-upload" hidden accept=".txt,.pdf,.docx" onChange={handleFileUpload} />
              {fileText && <div className="file-preview">📄 {fileText.length} characters loaded</div>}
            </div>
          </div>
          <button className="btn-primary btn-large" onClick={handleCreate} disabled={busy}>
            {busy ? "🤖 AI is building your plan…" : "🚀 Create Smart Study Plan"}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="planner-view">
          {/* Header */}
          <div className="planner-header-row">
            <div className="points-badge">⭐ {points} pts</div>
            <div className="planner-header-actions">
              <button className="btn-ghost btn-sm" onClick={openEditSubjects}>📚 Edit Subjects</button>
              <button className="btn-ghost btn-sm" style={{background:"var(--color-accent-soft)",color:"var(--color-accent-strong)",fontWeight:700}} onClick={() => { setRevisionSchedule(null); setShowRevisionSetup(true); }}>🔄 Revision Plan</button>
              <button className="btn-ghost btn-sm" onClick={() => setStep(1)}>← New Plan</button>
            </div>
          </div>

          {/* Schedule */}
          <div className="schedule-container">
            {schedule.map((day, dIdx) => (
              <div key={dIdx} className="schedule-day">
                <div className="schedule-day-header">📆 {day.day}</div>
                <div className="schedule-sessions">
                  {(day.sessions || []).length === 0 && (
                    <div className="session-empty">No sessions planned</div>
                  )}
                  {(day.sessions || []).map((s, sIdx) => {
                    const key = `${dIdx}-${sIdx}`;
                    const done = completedSessions.has(key);
                    const isActiveTimer = currentQueued?.key === key && schedRunning && !done;
                    return (
                      <div key={sIdx}
                        className={`schedule-session ${s.type === "break" ? "session-break" : "session-study"} ${done ? "session-done" : ""} ${isActiveTimer ? "session-active-timer" : ""}`}>
                        <div className="session-time-col">
                          <div className="session-time">{s.startTime || "—"}</div>
                          <div className="session-dur-badge">{s.duration || "—"}</div>
                        </div>
                        <div className="session-info">
                          <div className="session-subject">
                            {s.type === "break" ? "☕" : "📖"} {s.subject}
                          </div>
                        </div>
                        <div className="session-actions">
                          {isActiveTimer && <span className="timer-live">{formatTime(schedTimeLeft)}</span>}
                          {done && <span className="session-done-badge">✅</span>}
                          {!done && s.type !== "break" && (
                            <button className="session-btn session-focus" title="Focus Mode"
                              onClick={() => { setTimerQueueIdx(timerQueue.findIndex(q => q.key === key) || 0); setSchedTimeLeft(parseDurationToSecs(s.duration)); enterFocusMode("schedule"); }}>🎯</button>
                          )}
                          <button className="session-btn session-edit" title="Edit" onClick={() => openEditSession(dIdx, sIdx)}>✏️</button>
                          <button className="session-btn session-delete" title="Delete" onClick={() => deleteSession(dIdx, sIdx)}>🗑️</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Timers side by side */}
          <div className="timers-row">
            {/* Schedule Timer */}
            <div className="timer-card timer-card-schedule">
              <div className="timer-card-title">📅 Schedule Timer</div>
              <div className="timer-card-subject">{currentQueued ? `${currentQueued.type === "break" ? "☕" : "📖"} ${currentQueued.subject}` : "All sessions done!"}</div>
              <div className="timer-card-time">{formatTime(schedTimeLeft)}</div>
              <div className="timer-card-meta">Session {timerQueueIdx + 1} / {timerQueue.length}</div>
              <div className="timer-card-controls">
                {!schedRunning
                  ? <button className="btn-primary" onClick={() => setSchedRunning(true)} disabled={!currentQueued}>▶ Start</button>
                  : <button className="btn-secondary" onClick={() => setSchedRunning(false)}>⏸ Pause</button>}
                <button className="btn-ghost" onClick={() => { setSchedRunning(false); setSchedTimeLeft(parseDurationToSecs(currentQueued?.duration)); }}>↺</button>
                <button className="btn-ghost" onClick={() => enterFocusMode("schedule")}>🎯 Focus</button>
              </div>
              {timesUpNotif && (
                <div className="timer-notif">
                  ⏰ Time's up!
                  <button className="btn-primary btn-sm" style={{marginLeft:8}} onClick={markSessionDone}>✅ Next</button>
                </div>
              )}
            </div>

            {/* Pomodoro Timer */}
            <div className="timer-card timer-card-pomodoro">
              <div className="timer-card-title">⏱️ Pomodoro Timer</div>
              <div className="timer-card-subject">{pomodoroMode === "work" ? "🎯 Focus Session" : "☕ Break Time"}</div>
              <div className={`timer-card-time ${pomodoroMode === "break" ? "pomodoro-break" : ""}`}>{formatTime(pomodoroLeft)}</div>
              <div className="timer-card-meta">{pomodoroMode === "work" ? "25 min focus" : "5 min break"}</div>
              <div className="timer-card-controls">
                {!pomodoroRunning
                  ? <button className="btn-primary" onClick={() => setPomodoroRunning(true)}>▶ Start</button>
                  : <button className="btn-secondary" onClick={() => setPomodoroRunning(false)}>⏸ Pause</button>}
                <button className="btn-ghost" onClick={() => { setPomodoroRunning(false); setPomodoroMode("work"); setPomodoroLeft(POMODORO_SECS); }}>↺</button>
                <button className="btn-ghost" onClick={() => enterFocusMode("pomodoro")}>🎯 Focus</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* ── Revision Plan Setup Modal ── */}
    {showRevisionSetup && (
      <div className="edit-modal-overlay">
        <div className="edit-modal">
          <h3 className="edit-modal-title">🔄 Create Revision Plan</h3>
          <p className="card-subtitle">Revision sessions are shorter — helping you review what you already learned.</p>

          <div className="settings-group">
            <label className="settings-label">⏰ Hours per day: <strong>{revisionHours}h</strong></label>
            <input type="range" min="0.5" max="4" step="0.5" value={revisionHours} className="settings-range"
              onChange={e => setRevisionHours(Number(e.target.value))} />
          </div>

          <div className="settings-group">
            <label className="settings-label">📅 Study days</label>
            <div className="day-selector">
              {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
                <button key={d} type="button"
                  className={`day-btn ${revisionStudyDays.includes(d) ? "day-btn-active" : ""}`}
                  onClick={() => setRevisionStudyDays(prev => prev.includes(d) ? prev.filter(x=>x!==d) : [...prev,d])}>{d}</button>
              ))}
            </div>
          </div>

          <div className="revision-info-box">
            📌 Your revision sessions will be about <strong>60% shorter</strong> than your original study sessions — perfect for quick, focused reviews!
          </div>

          <div className="actions-row">
            <button className="btn-primary" onClick={createRevisionPlan} disabled={busyRevision}>
              {busyRevision ? "🤖 Creating…" : "🔄 Generate Revision Plan"}
            </button>
            <button className="btn-ghost" onClick={() => setShowRevisionSetup(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}

    {/* ── Revision Schedule View ── */}
    {revisionSchedule && !showRevisionSetup && (
      <div className="revision-overlay">
        <div className="revision-panel">
          <div className="revision-header">
            <div>
              <h3 className="revision-title">🔄 Your Revision Plan</h3>
              <p className="card-subtitle">Shorter, focused sessions to review what you've learned.</p>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => setRevisionSchedule(null)}>✕ Close</button>
          </div>
          <div className="revision-badge">⚡ Sessions are 60% shorter than original</div>
          <div className="schedule-container">
            {revisionSchedule.map((day, dIdx) => (
              <div key={dIdx} className="schedule-day revision-day">
                <div className="schedule-day-header">🔄 {day.day}</div>
                <div className="schedule-sessions">
                  {(day.sessions || []).map((s, sIdx) => (
                    <div key={sIdx} className={`schedule-session ${s.type === "break" ? "session-break" : "session-study session-revision"}`}>
                      <div className="session-time-col">
                        <div className="session-time">{s.startTime || "—"}</div>
                        <div className="session-dur-badge revision-dur">{s.duration || "—"}</div>
                      </div>
                      <div className="session-info">
                        <div className="session-subject">{s.type === "break" ? "☕" : "🔄"} {s.subject}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="revision-actions">
            <button className="btn-primary" onClick={() => {
              // Replace main schedule with revision schedule
              setSchedule(revisionSchedule);
              buildTimerQueue(revisionSchedule);
              setCompletedSessions(new Set());
              setPoints(0);
              setRevisionSchedule(null);
              setStep(2);
            }}>
              ✅ Use as Main Schedule
            </button>
            <button className="btn-ghost" onClick={() => { setShowRevisionSetup(true); setRevisionSchedule(null); }}>
              ✏️ Adjust Settings
            </button>
            <button className="btn-ghost" onClick={() => setRevisionSchedule(null)}>
              Keep Original
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
  const emitToast = (msg, type = "error") => {
    window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg, type } }));
  };

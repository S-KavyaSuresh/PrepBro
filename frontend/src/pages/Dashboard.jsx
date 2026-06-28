import React, { useEffect, useRef, useState } from "react";
import { apiFetch, withJsonBody } from "../lib/api.js";
import {
  buildBadgeSummary,
  fetchAccountProgress,
  getDayLabel,
  getLast7DayKeys,
  getTodayKey,
  loadAccountProgress,
  loadStats,
  markGoalCelebrationShown,
} from "../lib/tracker.js";
import { loadAuthSession, loadGuestProfile, saveAuthSession } from "../lib/auth.js";

const GUEST_GOALS_KEY = "prepbro_guest_goals";
const ASSIGNMENT_REMINDER_KEY = "prepbro_assignment_due_reminders";
const BADGE_IMAGE_MAP = {
  "First Steps": "/badges/first-steps.png",
  "One Hour Hero": "/badges/one-hour-hero.png",
  "Quiz Explorer": "/badges/quiz-explorer.png",
  "Consistency Star": "/badges/consistency-star.png",
  "PrepBro Pro": "/badges/prepbro-pro.png",
  "Daily Goal Champion": "/badges/daily-goal-champion.png",
  "3-Day Streak": "/badges/three-day-streak.png",
  "7-Day Streak": "/badges/seven-day-streak.png",
  "30 Day Streak": "/badges/thirty-day-streak.png",
  "Focus Master": "/badges/focus-master.png",
  "Schedule Starter": "/badges/schedule-starter.png",
  "Breaktime Balanced": "/badges/breaktime-balanced.png",
  "Subject Explorer": "/badges/subject-explorer.png",
  "Perfect Week": "/badges/perfect-week.png",
  "Mentor Ready": "/badges/mentor-ready.png",
};

const EMPTY_PROGRESS = {
  student_id: null,
  points: 0,
  streak: 0,
  study_minutes: 0,
  quizzes_completed: 0,
  daily_points: {},
  daily_minutes: {},
  badges: [],
  updated_at: null,
};

const EMPTY_GOAL_FORM = {
  title: "",
  description: "",
  due_date: "",
  priority: "",
};

const EMPTY_ASSIGNMENT_FORM = {
  title: "",
  description: "",
  due_date: "",
  priority: "",
  target_mode: "all",
  class_id: "",
  student_ids: [],
};

const EMPTY_CLASS_FORM = {
  name: "",
  description: "",
  subject: "",
  grade_level: "",
};

function getLocalDateInputValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatMinutes(mins) {
  const total = Number(mins || 0);
  if (!total) return "0m";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function openToast(message, type = "success") {
  window.dispatchEvent(new CustomEvent("mb:toast", { detail: { msg: message, type } }));
}

function parseIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatReadableDate(value, { includeTime = false } = {}) {
  const date = parseIso(value);
  if (!date) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  if (sameDay && includeTime) {
    return `today at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  if (isTomorrow && !includeTime) return "tomorrow";
  if (includeTime) {
    return date.toLocaleString([], {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function formatDueDateText(value) {
  if (!value) return "No due date";
  return `Due ${formatReadableDate(value)}`;
}

function formatAssignedText(mentorName, value) {
  const name = mentorName || "Mentor";
  return `Assigned by ${name} on ${formatReadableDate(value, { includeTime: true })}`;
}

function readReminderState() {
  try {
    return JSON.parse(localStorage.getItem(ASSIGNMENT_REMINDER_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeReminderState(nextState) {
  localStorage.setItem(ASSIGNMENT_REMINDER_KEY, JSON.stringify(nextState));
}

function loadGuestGoals() {
  try {
    return JSON.parse(localStorage.getItem(GUEST_GOALS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveGuestGoals(goals) {
  localStorage.setItem(GUEST_GOALS_KEY, JSON.stringify(goals));
}

function normalizeStudentAssignment(item) {
  return {
    ...item,
    status: item.status === "assigned" ? "pending" : item.status,
    feedback: item.feedback || "",
  };
}

function buildMetrics(progress, mode, session) {
  const guestProfile = loadGuestProfile() || {};
  if (mode === "guest") {
    const stats = loadStats();
    return {
      points: stats.points || 0,
      streak: stats.streak || 0,
      studyMinutes: stats.totalMinutes || 0,
      quizzesCompleted: stats.quizzesCompleted || 0,
      sessionsCompleted: stats.sessionsCompleted || 0,
      subjectMinutes: stats.subjectMinutes || {},
      dailyGoalCompletedDays: stats.dailyGoalCompletedDays || [],
      mentorLinked: false,
      dailyPoints: stats.dailyPoints || {},
      dailyMinutes: stats.dailyMinutes || {},
      dailyTargetMinutes: Number(guestProfile.daily_study_target_minutes || 0),
    };
  }
  return {
    points: progress.points || 0,
    streak: progress.streak || 0,
    studyMinutes: progress.study_minutes || 0,
    quizzesCompleted: progress.quizzes_completed || 0,
    sessionsCompleted: 0,
    subjectMinutes: {},
    dailyGoalCompletedDays: progress.daily_goal_completed_days || [],
    mentorLinked: Boolean(session?.user?.preferences_json?.teacher_email),
    dailyPoints: progress.daily_points || {},
    dailyMinutes: progress.daily_minutes || {},
    dailyTargetMinutes: Number(session?.user?.preferences_json?.daily_study_target_minutes || 0),
  };
}

function getBadgeProgress(badgeId, metrics) {
  const streak = Number(metrics.streak || 0);
  const points = Number(metrics.points || 0);
  const minutes = Number(metrics.studyMinutes || 0);
  const quizzes = Number(metrics.quizzesCompleted || 0);
  const goalDays = Number((metrics.dailyGoalCompletedDays || []).length || 0);
  const subjects = Object.keys(metrics.subjectMinutes || {}).filter((key) => Number(metrics.subjectMinutes[key] || 0) > 0).length;
  switch (badgeId) {
    case "One Hour Hero":
      return { current: minutes, target: 60, unit: "minutes" };
    case "Quiz Explorer":
      return { current: quizzes, target: 1, unit: "quiz" };
    case "Consistency Star":
      return { current: streak, target: 3, unit: "days" };
    case "PrepBro Pro":
      return { current: points, target: 200, unit: "points" };
    case "Daily Goal Champion":
      return { current: goalDays, target: 1, unit: "days" };
    case "3-Day Streak":
      return { current: streak, target: 3, unit: "days" };
    case "7-Day Streak":
      return { current: streak, target: 7, unit: "days" };
    case "30 Day Streak":
      return { current: streak, target: 30, unit: "days" };
    case "Focus Master":
      return { current: Number(metrics.sessionsCompleted || 0), target: 5, unit: "sessions" };
    case "Schedule Starter":
      return { current: Number(metrics.sessionsCompleted || 0), target: 1, unit: "session" };
    case "Breaktime Balanced":
      return { current: minutes, target: 50, unit: "minutes" };
    case "Subject Explorer":
      return { current: subjects, target: 3, unit: "subjects" };
    case "Perfect Week":
      return { current: goalDays, target: 7, unit: "days" };
    case "Mentor Ready":
      return { current: metrics.mentorLinked ? 1 : 0, target: 1, unit: "link" };
    case "First Steps":
    default:
      return { current: points > 0 || minutes > 0 || quizzes > 0 ? 1 : 0, target: 1, unit: "step" };
  }
}

function getBadgeNarrative(badge, metrics, achieved) {
  const progress = getBadgeProgress(badge.id, metrics);
  const pluralizedUnit = progress.unit.endsWith("s")
    ? progress.unit
    : `${progress.unit}${progress.target === 1 ? "" : "s"}`;
  if (achieved) {
    return {
      heading: `${badge.label} unlocked`,
      detail: `${badge.label} was earned because you met this goal: ${badge.description}`,
      progressText: `${progress.current} / ${progress.target} ${pluralizedUnit}`,
    };
  }
  const remaining = Math.max(progress.target - progress.current, 0);
  return {
    heading: badge.label,
    detail: badge.description,
    progressText: `${progress.current} / ${progress.target} ${pluralizedUnit}${remaining ? ` • ${remaining} ${pluralizedUnit} remaining` : ""}`,
  };
}

function downloadTextReport(filename, reportText) {
  const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function StatCard({ value, label, accentClass = "" }) {
  return (
    <article className={`stat-card ${accentClass}`.trim()}>
      <div className="stat-kicker">{label}</div>
      <div className="stat-value">{value}</div>
    </article>
  );
}

function ChartSection({ title, values }) {
  const maxValue = Math.max(...values.map((item) => item.value), 1);
  return (
    <section className="card dashboard-chart-section">
      <h3 className="card-subheading">{title}</h3>
      <div className="chart-row">
        {values.map((item) => (
          <div className="chart-item" key={item.key}>
            <div className="chart-bar-wrap">
              <div className="chart-bar" style={{ height: `${Math.max((item.value / maxValue) * 100, item.value ? 12 : 6)}%` }} />
            </div>
            <span className="chart-label">{item.label}</span>
            <span className="chart-value">{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BadgeCard({ badge, achieved, metrics, onClick }) {
  const narrative = getBadgeNarrative(badge, metrics, achieved);
  return (
    <button
      type="button"
      className={`badge-medal-card ${achieved ? "badge-medal-card-active" : "badge-medal-card-locked"}`}
      onClick={onClick}
    >
      <div className="badge-medal-shell">
        <img
          src={BADGE_IMAGE_MAP[badge.id]}
          alt={badge.label}
          className={`badge-medal-image ${achieved ? "" : "badge-preview-image-locked"}`.trim()}
        />
        {!achieved ? <span className="badge-medal-lock">Locked</span> : null}
      </div>
      <div className="badge-medal-copy">
        <strong>{badge.label}</strong>
        <span>{achieved ? "Tap to view details" : narrative.progressText}</span>
      </div>
    </button>
  );
}

function BadgePreviewModal({ badge, achieved, metrics, onClose }) {
  useEffect(() => {
    if (!badge) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [badge, onClose]);

  if (!badge) return null;
  const narrative = getBadgeNarrative(badge, metrics, achieved);
  return (
    <div className="badge-preview-overlay" onClick={onClose} role="presentation">
      <div
        className={`badge-preview-card ${achieved ? "" : "badge-preview-card-locked"}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={badge.label}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="badge-preview-close" type="button" onClick={onClose} aria-label="Close badge details" />
        <div className="badge-preview-image-wrap">
          <img
            src={BADGE_IMAGE_MAP[badge.id]}
            alt={badge.label}
            className={`badge-preview-image ${achieved ? "" : "badge-preview-image-locked"}`.trim()}
          />
        </div>
        <div className="badge-preview-copy">
          <h3>{badge.label}</h3>
          <p>{narrative.detail}</p>
          <div className="badge-preview-meta">
            <span>{achieved ? "Achieved" : "Locked"}</span>
            <span>{narrative.progressText}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssignmentNoticeModal({ items, onView, onLater, onMarkSeen }) {
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    setSelectedId(items[0]?.id ?? null);
  }, [items]);

  if (!items.length) return null;
  const selectedItem = items.find((item) => item.id === selectedId) || items[0];
  return (
    <div className="unsaved-overlay" role="presentation">
      <div className="unsaved-dialog" role="dialog" aria-modal="true" aria-label="New assignments">
        <h3 className="card-subheading">New assignments from your mentor</h3>
        <div className="dashboard-assignment-group">
          {items.map((item) => (
            <article
              className={`card assignment-card assignment-popup-card ${selectedItem?.id === item.id ? "assignment-popup-card-selected" : ""}`}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSelectedId(item.id);
              }}
            >
              <strong>{item.title}</strong>
              <p className="assignment-description">{item.description || "No description added yet."}</p>
              <div className="assignment-meta-list">
                <span>{item.due_date ? formatDueDateText(item.due_date) : "No due date"}</span>
                <span>{formatAssignedText(item.mentor_name, item.assigned_at)}</span>
              </div>
            </article>
          ))}
        </div>
        <div className="account-settings-actions">
          <button className="btn-primary" type="button" onClick={() => selectedItem ? onView(selectedItem.id) : null}>View Assignment</button>
          <button className="btn-ghost" type="button" onClick={onMarkSeen}>Mark as Seen</button>
          <button className="btn-ghost" type="button" onClick={onLater}>Later</button>
        </div>
      </div>
    </div>
  );
}

function AssignmentReminderModal({ items, onView, onDismiss }) {
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    setSelectedId(items[0]?.id ?? null);
  }, [items]);

  if (!items.length) return null;
  const selectedItem = items.find((item) => item.id === selectedId) || items[0];
  return (
    <div className="unsaved-overlay" role="presentation">
      <div className="unsaved-dialog" role="dialog" aria-modal="true" aria-label="Assignment due reminders">
        <h3 className="card-subheading">Assignments due tomorrow</h3>
        <div className="dashboard-assignment-group">
          {items.map((item) => (
            <article
              className={`card assignment-card assignment-popup-card ${selectedItem?.id === item.id ? "assignment-popup-card-selected" : ""}`}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSelectedId(item.id);
              }}
            >
              <strong>{item.title}</strong>
              <p className="assignment-description">This assignment is due tomorrow.</p>
              {item.description ? <p className="assignment-description">{item.description}</p> : null}
              <div className="assignment-meta-list">
                <span>{`Assigned by: ${item.mentor_name || "Mentor"}`}</span>
                <span>{`Due: ${formatReadableDate(item.due_date) || "Tomorrow"}`}</span>
                <span>{`Assigned: ${formatReadableDate(item.assigned_at, { includeTime: true })}`}</span>
              </div>
            </article>
          ))}
        </div>
        <div className="account-settings-actions">
          <button className="btn-primary" type="button" onClick={() => selectedItem ? onView(selectedItem.id) : null}>View Assignment</button>
          <button className="btn-ghost" type="button" onClick={onDismiss}>Dismiss for Today</button>
        </div>
      </div>
    </div>
  );
}

function AssignmentDetailModal({ assignment, onClose }) {
  useEffect(() => {
    if (!assignment) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assignment, onClose]);

  if (!assignment) return null;
  return (
    <div className="badge-preview-overlay" onClick={onClose} role="presentation">
      <div className="badge-preview-card" role="dialog" aria-modal="true" aria-label={assignment.title} onClick={(event) => event.stopPropagation()}>
        <button className="badge-preview-close" type="button" onClick={onClose} aria-label="Close assignment details" />
        <div className="badge-preview-copy">
          <h3>{assignment.title}</h3>
          <p className="assignment-description">{assignment.description || "No description added yet."}</p>
          <div className="badge-preview-meta assignment-meta-list">
            <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
            <span>{formatAssignedText(assignment.mentor_name, assignment.assigned_at || assignment.created_at)}</span>
            {assignment.max_marks ? <span>{`Marks: ${assignment.marks_obtained ?? 0} / ${assignment.max_marks}`}</span> : null}
            {assignment.feedback ? <span>{`Mentor Feedback: ${assignment.feedback}`}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClassAssignmentModal({ draft, learner, classes, mentorName, onConfirm, onCancel }) {
  if (!draft || !learner) return null;
  const currentClass = learner.class?.name || learner.class_level || "Class not set";
  const nextClass = classes.find((item) => String(item.id) === String(draft.class_id))?.name || "Class not set";
  return (
    <div className="badge-preview-overlay" role="presentation" onClick={onCancel}>
      <div className="badge-preview-card class-assignment-dialog" role="dialog" aria-modal="true" aria-label="Confirm class assignment" onClick={(event) => event.stopPropagation()}>
        <div className="badge-preview-copy">
          <h3>Confirm Class</h3>
          <p>Are you sure you want to assign this learner to this class?</p>
          <div className="class-assignment-review">
            <div><strong>Learner</strong><span>{learner.learner_name}</span></div>
            <div><strong>Current Class</strong><span>{currentClass}</span></div>
            <div><strong>New Class</strong><span>{nextClass}</span></div>
            <div><strong>Mentor</strong><span>{mentorName}</span></div>
          </div>
        </div>
        <div className="account-settings-actions mentor-class-confirm-actions">
          <button className="btn-primary" type="button" onClick={onConfirm}>Confirm Class Assignment</button>
          <button className="btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ title, copy, confirmLabel, onConfirm, onCancel }) {
  if (!title) return null;
  return (
    <div className="badge-preview-overlay" role="presentation" onClick={onCancel}>
      <div className="badge-preview-card" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="badge-preview-copy">
          <h3>{title}</h3>
          <p>{copy}</p>
        </div>
        <div className="account-settings-actions">
          <button className="btn-danger" type="button" onClick={onConfirm}>{confirmLabel}</button>
          <button className="btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function MentorAssignmentDetailModal({ assignment, onClose, onGradeChange, onSaveGrade, gradesDraft }) {
  const [feedbackOpenByStudent, setFeedbackOpenByStudent] = useState({});

  useEffect(() => {
    setFeedbackOpenByStudent({});
  }, [assignment?.id]);

  if (!assignment) return null;
  return (
    <div className="badge-preview-overlay" role="presentation" onClick={onClose}>
      <div className="badge-preview-card mentor-assignment-detail-dialog" role="dialog" aria-modal="true" aria-label={assignment.title} onClick={(event) => event.stopPropagation()}>
        <button className="badge-preview-close" type="button" onClick={onClose} aria-label="Close assignment details" />
        <div className="mentor-assignment-detail-content">
          <div className="mentor-assignment-detail-head">
            <div className="mentor-assignment-detail-title-block">
              <h3>{assignment.title}</h3>
            </div>
          </div>
          <p className="assignment-description">{assignment.description || "No description added yet."}</p>
          <div className="assignment-meta-list mentor-assignment-meta-list">
            <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
            <span>{assignment.class_name ? `Class: ${assignment.class_name}` : "Targeted learners"}</span>
            <span>{`${assignment.targets.length} learner(s)`}</span>
          </div>
          <div className="mentor-assignment-targets-scroll">
            {assignment.targets.map((target) => {
              const draft = gradesDraft[target.student_id] || {
              marks_obtained: target.marks_obtained ?? "",
              max_marks: target.max_marks ?? "",
              feedback: target.feedback || "",
            };
              
              return (
                <article className="card assignment-grade-card" key={`${assignment.id}-${target.student_id}`}>
                  <div className="assignment-grade-card-head">
                    <div className="assignment-grade-card-title">
                      <strong>{target.learner_name}</strong>
                      <span className={`assignment-status-pill ${target.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                        {target.status === "completed" ? "Completed" : "Pending"}
                      </span>
                    </div>
                    <div className="assignment-grade-meta">
                      {target.completed_at ? <span>{`Completed ${formatReadableDate(target.completed_at, { includeTime: true })}`}</span> : <span>Not completed yet</span>}
                    </div>
                  </div>
                  <div className="assignment-grade-controls-row">
                    <input
                      className="assignment-grade-inline-input"
                      type="number"
                      aria-label={`Marks obtained for ${target.learner_name}`}
                      placeholder="Marks"
                      value={draft.marks_obtained}
                      onChange={(event) => onGradeChange(target.student_id, "marks_obtained", event.target.value)}
                    />
                    <input
                      className="assignment-grade-inline-input"
                      type="number"
                      aria-label={`Max marks for ${target.learner_name}`}
                      placeholder="Max"
                      value={draft.max_marks}
                      onChange={(event) => onGradeChange(target.student_id, "max_marks", event.target.value)}
                    />
                    <button
                      className="btn-ghost assignment-feedback-toggle"
                      type="button"
                      onClick={() => setFeedbackOpenByStudent((current) => ({ ...current, [target.student_id]: !current[target.student_id] }))}
                    >
                      Feedback
                    </button>
                    <button className="btn-primary" type="button" onClick={() => onSaveGrade(target.student_id)}>Save Marks</button>
                  </div>
                  {feedbackOpenByStudent[target.student_id] ? (
                    <label className="user-account-field assignment-feedback-field">
                      <span>Feedback</span>
                      <textarea
                        value={draft.feedback}
                        onChange={(event) => onGradeChange(target.student_id, "feedback", event.target.value)}
                      />
                    </label>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardAssignmentsSection({
  assignments,
  selfGoals,
  onView,
  onToggleStatus,
  onOpenGoalEditor,
  onDeleteGoal,
  mode,
}) {
  return (
    <section className="card student-assignments-section">
      <div className="managed-students-dashboard-head">
        <div>
          <h3 className="card-subheading">Assignments & Goals</h3>
          <p className="account-settings-meta">Mentor tasks and personal goals stay here.</p>
        </div>
        <button className="btn-primary" type="button" onClick={() => onOpenGoalEditor(null)}>Add Self Goal</button>
      </div>

      <div className="dashboard-assignment-group">
        <h4 className="card-subheading">Mentor Assigned</h4>
        {!assignments.length ? <p className="account-settings-meta">No assignments yet.</p> : null}
        {assignments.map((assignment) => (
          <article className="card assignment-card student-assignment-card" id={`assignment-${assignment.id}`} key={`student-assignment-${assignment.id}`}>
            <div className="student-assignment-copy">
              <strong>{assignment.title}</strong>
              <span>{assignment.description || "No description added yet."}</span>
              <span>{formatAssignedText(assignment.mentor_name, assignment.assigned_at || assignment.created_at)}</span>
              <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
              {assignment.max_marks ? <span>{`Marks: ${assignment.marks_obtained ?? 0} / ${assignment.max_marks}`}</span> : null}
              {assignment.feedback ? <span>{`Mentor Feedback: ${assignment.feedback}`}</span> : null}
            </div>
            <div className="student-assignment-actions">
              <span className={`assignment-status-pill ${assignment.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                {assignment.status === "completed" ? "Completed" : "Pending"}
              </span>
              <button className="btn-ghost" type="button" onClick={() => onView(assignment)}>
                View Assignment
              </button>
              {assignment.status !== "completed" ? (
                <button className="btn-primary" type="button" onClick={() => onToggleStatus(assignment, "completed")}>
                  Mark Completed
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      <div className="dashboard-assignment-group">
        <h4 className="card-subheading">{mode === "guest" ? "My Goals" : "Self Goals"}</h4>
        {!selfGoals.length ? <p className="account-settings-meta">No self goals yet.</p> : null}
        {selfGoals.map((goal) => (
          <article className="card assignment-card student-assignment-card" key={`goal-${goal.id}`}>
            <div className="student-assignment-copy">
              <strong>{goal.title}</strong>
              <span>{goal.description || "No description added yet."}</span>
              <span>{goal.due_date ? formatDueDateText(goal.due_date) : "No due date"}</span>
            </div>
            <div className="student-assignment-actions">
              <span className={`assignment-status-pill ${goal.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                {goal.status === "completed" ? "Completed" : "Pending"}
              </span>
              {goal.status !== "completed" ? (
                <button className="btn-primary" type="button" onClick={() => onToggleStatus(goal, "completed")}>
                  Mark Completed
                </button>
              ) : (
                <button className="btn-ghost" type="button" onClick={() => onToggleStatus(goal, "pending")}>
                  Undo Completion
                </button>
              )}
              <button className="btn-ghost" type="button" onClick={() => onOpenGoalEditor(goal)}>Edit</button>
              <button className="btn-ghost" type="button" onClick={() => onDeleteGoal(goal)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function StudentDashboard({ authSession, mode }) {
  const [view, setView] = useState("student");
  const [progress, setProgress] = useState(mode === "guest" ? null : loadAccountProgress());
  const [assignments, setAssignments] = useState([]);
  const [selfGoals, setSelfGoals] = useState(mode === "guest" ? loadGuestGoals() : []);
  const [badgeModal, setBadgeModal] = useState(null);
  const [goalEditor, setGoalEditor] = useState(null);
  const [goalForm, setGoalForm] = useState(EMPTY_GOAL_FORM);
  const [assignmentNoticeItems, setAssignmentNoticeItems] = useState([]);
  const [assignmentReminderItems, setAssignmentReminderItems] = useState([]);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const assignmentRefs = useRef({});

  const role = authSession?.user?.role || "guest";
  const guestStats = mode === "guest" ? loadStats() : null;
  const currentProgress = mode === "guest"
    ? {
      ...EMPTY_PROGRESS,
      points: guestStats?.points || 0,
      streak: guestStats?.streak || 0,
      study_minutes: guestStats?.totalMinutes || 0,
      quizzes_completed: guestStats?.quizzesCompleted || 0,
      daily_points: guestStats?.dailyPoints || {},
      daily_minutes: guestStats?.dailyMinutes || {},
      daily_goal_completed_days: guestStats?.dailyGoalCompletedDays || [],
      updated_at: guestStats?.lastActive || null,
    }
    : { ...EMPTY_PROGRESS, ...(progress || EMPTY_PROGRESS) };

  const metrics = buildMetrics(currentProgress, mode, authSession);
  const badgeSummary = buildBadgeSummary(metrics);
  const dayKeys = getLast7DayKeys();
  const pointChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyPoints[key] || 0) }));
  const minuteChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyMinutes[key] || 0) }));
  const totalStudyTime = formatMinutes(metrics.studyMinutes || 0);
  const accuracy = currentProgress.quizzes_completed > 0
    ? `${Math.min(99, 70 + Math.floor(currentProgress.quizzes_completed * 1.2))}%`
    : "—";
  const subjectData = Object.entries(metrics.subjectMinutes || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 6);
  const maxPts = Math.max(...pointChart.map((item) => item.value), 1);
  const maxMins = Math.max(...minuteChart.map((item) => item.value), 1);
  useEffect(() => {
    if (mode === "guest") {
      setSelfGoals(loadGuestGoals());
      return;
    }
    let cancelled = false;
    async function loadStudentData() {
      try {
        const [nextProgress, mentorAssignments, nextGoals] = await Promise.all([
          fetchAccountProgress(),
          apiFetch("/student/assignments"),
          apiFetch("/student/self-goals"),
        ]);
        if (cancelled) return;
        const normalizedAssignments = mentorAssignments.map(normalizeStudentAssignment);
        setProgress(nextProgress);
        setAssignments(normalizedAssignments);
        setSelfGoals(nextGoals.map(normalizeStudentAssignment));
        setAssignmentNoticeItems(normalizedAssignments.filter((item) => item.status !== "completed" && !item.seen_at));
        const reminderState = readReminderState();
        const todayKey = getTodayKey();
        setAssignmentReminderItems(
          normalizedAssignments.filter((item) => item.status !== "completed" && item.due_date && formatReadableDate(item.due_date) === "tomorrow" && reminderState[`${todayKey}:${item.id}`] !== true),
        );
      } catch (error) {
        openToast(error.message || "Could not load dashboard data.", "error");
      }
    }
    loadStudentData();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    function handleProgressChanged() {
      if (mode === "guest") {
        setSelfGoals(loadGuestGoals());
      }
    }
    window.addEventListener("prepbro:progress-changed", handleProgressChanged);
    return () => window.removeEventListener("prepbro:progress-changed", handleProgressChanged);
  }, [mode]);

  useEffect(() => {
    if (mode === "guest") return;
    if (window.location.hash.startsWith("#assignment-")) {
      const id = window.location.hash.replace("#assignment-", "");
      const node = assignmentRefs.current[id];
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("assignment-card-highlighted");
        window.setTimeout(() => node.classList.remove("assignment-card-highlighted"), 1800);
      }
    }
  }, [assignments, mode]);

  useEffect(() => {
    if (mode === "guest") return;
    if (currentProgress?.daily_goal_completed_days?.length && authSession?.user?.role === "student") {
      const shouldCelebrate = (() => {
        const today = getTodayKey();
        return currentProgress.daily_goal_completed_days.includes(today) && !(currentProgress.shown_celebrations || []).includes(today);
      })();
      if (shouldCelebrate) {
        openToast("Daily goal completed!", "success");
        markGoalCelebrationShown();
      }
    }
  }, [authSession?.user?.role, currentProgress, mode]);

  function handleBadgeClick(badge, achieved) {
    setBadgeModal({ badge, achieved });
  }

  function handleViewAssignment(assignment) {
    if (assignment.id) {
      window.history.replaceState({}, "", `#assignment-${assignment.id}`);
      const node = assignmentRefs.current[String(assignment.id)];
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("assignment-card-highlighted");
        window.setTimeout(() => node.classList.remove("assignment-card-highlighted"), 1800);
      }
    }
  }

  async function updateAssignmentStatus(item, status) {
    try {
      if (mode === "guest") {
        const nextGoals = loadGuestGoals().map((goal) => (goal.id === item.id ? { ...goal, status, completed_at: status === "completed" ? new Date().toISOString() : null } : goal));
        saveGuestGoals(nextGoals);
        setSelfGoals(nextGoals);
        return;
      }
      const endpoint = item.assignment_type === "self_assigned"
        ? `/student/assignments/${item.id}/status`
        : `/student/assignments/${item.id}/status`;
      const response = await apiFetch(endpoint, withJsonBody("PUT", { status }));
      if (item.assignment_type === "self_assigned") {
        setSelfGoals((current) => current.map((goal) => (goal.id === item.id ? normalizeStudentAssignment(response.assignment) : goal)));
      } else {
        setAssignments((current) => current.map((assignment) => (assignment.id === item.id ? normalizeStudentAssignment(response.assignment) : assignment)));
      }
    } catch (error) {
      openToast(error.message || "Could not update assignment status.", "error");
    }
  }

  async function saveGoal() {
    const title = goalForm.title.trim();
    if (!title) {
      openToast("Goal title is required.", "error");
      return;
    }
    try {
      if (mode === "guest") {
        const existingGoals = loadGuestGoals();
        if (goalEditor?.id) {
          const updated = existingGoals.map((goal) => (goal.id === goalEditor.id ? { ...goal, ...goalForm } : goal));
          saveGuestGoals(updated);
          setSelfGoals(updated);
        } else {
          const created = [{ id: Date.now(), ...goalForm, status: "pending", assignment_type: "self_assigned", created_at: new Date().toISOString() }, ...existingGoals];
          saveGuestGoals(created);
          setSelfGoals(created);
        }
      } else if (goalEditor?.id) {
        const response = await apiFetch(`/student/self-goals/${goalEditor.id}`, withJsonBody("PUT", goalForm));
        setSelfGoals((current) => current.map((goal) => (goal.id === goalEditor.id ? normalizeStudentAssignment(response.goal) : goal)));
      } else {
        const response = await apiFetch("/student/self-goals", withJsonBody("POST", goalForm));
        setSelfGoals((current) => [normalizeStudentAssignment(response.goal), ...current]);
      }
      setGoalEditor(null);
      setGoalForm(EMPTY_GOAL_FORM);
    } catch (error) {
      openToast(error.message || "Could not save goal.", "error");
    }
  }

  async function deleteGoal(goal) {
    try {
      if (mode === "guest") {
        const nextGoals = loadGuestGoals().filter((item) => item.id !== goal.id);
        saveGuestGoals(nextGoals);
        setSelfGoals(nextGoals);
      } else {
        await apiFetch(`/student/self-goals/${goal.id}`, { method: "DELETE" });
        setSelfGoals((current) => current.filter((item) => item.id !== goal.id));
      }
    } catch (error) {
      openToast(error.message || "Could not delete goal.", "error");
    }
  }

  async function markNoticesSeen() {
    if (!assignmentNoticeItems.length) return;
    try {
      await Promise.all(assignmentNoticeItems.map((item) => apiFetch(`/student/assignments/${item.id}/seen`, withJsonBody("PUT", { seen: true }))));
      setAssignments((current) => current.map((item) => (assignmentNoticeItems.some((notice) => notice.id === item.id) ? { ...item, seen_at: new Date().toISOString() } : item)));
      setAssignmentNoticeItems([]);
    } catch (error) {
      openToast(error.message || "Could not update assignment notices.", "error");
    }
  }

  function dismissRemindersForToday() {
    const todayKey = getTodayKey();
    const state = readReminderState();
    assignmentReminderItems.forEach((item) => {
      state[`${todayKey}:${item.id}`] = true;
    });
    writeReminderState(state);
    setAssignmentReminderItems([]);
  }

  async function handleNoticeView(assignmentId) {
    const chosen = assignments.find((item) => item.id === assignmentId);
    if (!chosen) {
      setAssignmentNoticeItems([]);
      return;
    }
    await apiFetch(`/student/assignments/${assignmentId}/seen`, withJsonBody("PUT", { seen: true }));
    setAssignments((current) => current.map((item) => (item.id === assignmentId ? { ...item, seen_at: new Date().toISOString() } : item)));
    setAssignmentNoticeItems((current) => current.filter((item) => item.id !== assignmentId));
    handleViewAssignment({ ...chosen, seen_at: new Date().toISOString() });
  }

  async function downloadCurrentUserReport() {
    if (mode === "guest") {
      const guest = loadGuestProfile() || {};
      downloadTextReport(
        "prepbro_guest_report.txt",
        [
          "PrepBro Student Report",
          `Student: ${guest.display_name || "Guest"}`,
          `Age: ${guest.age || "Not set"}`,
          `Points: ${currentProgress.points}`,
          `Streak: ${currentProgress.streak}`,
          `Study Minutes: ${currentProgress.study_minutes}`,
          `Quizzes Completed: ${currentProgress.quizzes_completed}`,
        ].join("\n"),
      );
      return;
    }
    const profile = authSession?.user;
    const students = await apiFetch("/managed-students");
    const student = students[0];
    if (!student) {
      openToast("No learner report is available yet.", "error");
      return;
    }
    const report = await apiFetch(`/students/${student.id}/report`);
    downloadTextReport(report.filename, report.report_text);
    if (profile) {
      saveAuthSession({ token: loadAuthSession()?.token, expires_at: loadAuthSession()?.expires_at, user: profile });
    }
  }

  function resetGuestStats() {
    if (mode !== "guest") return;
    localStorage.removeItem("prepbro_guest_stats");
    setSelfGoals(loadGuestGoals().filter(() => false));
    setProgress(null);
    setShowResetConfirm(false);
    window.location.reload();
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <h2 className="card-title">📊 Learning Dashboard</h2>
        <div className="dashboard-view-tabs">
          <button className={`view-tab ${view === "student" ? "view-tab-active" : ""}`} type="button" onClick={() => setView("student")}>👤 Student</button>
          <button className={`view-tab ${view === "parent" ? "view-tab-active" : ""}`} type="button" onClick={() => setView("parent")}>👪 Parent</button>
          <button className={`view-tab ${view === "mentor" ? "view-tab-active" : ""}`} type="button" onClick={() => setView("mentor")}>🎓 Mentor</button>
        </div>
      </div>

      {view === "student" ? (
        <div>
          <div className="stats-grid">
            <div className="stat-card stat-points"><div className="stat-kicker">⭐</div><div className="stat-value">{currentProgress.points || 0}</div><div className="stat-label">Total Points</div></div>
            <div className="stat-card stat-streak"><div className="stat-kicker">🔥</div><div className="stat-value">{currentProgress.streak || 0}</div><div className="stat-label">Day Streak</div></div>
            <div className="stat-card stat-time"><div className="stat-kicker">⏰</div><div className="stat-value">{totalStudyTime}</div><div className="stat-label">Study Time</div></div>
            <div className="stat-card stat-accuracy"><div className="stat-kicker">🎯</div><div className="stat-value">{currentProgress.quizzes_completed || 0}</div><div className="stat-label">Quizzes Done</div></div>
          </div>

          {mode === "guest" ? <p className="dashboard-helper-text">Guest progress is saved on this device.</p> : null}

          <div className="card-subsection">
            <div className="managed-students-dashboard-head">
              <h3 className="card-subheading">📈 Points Earned - Last 7 Days</h3>
              <button className="btn-primary dashboard-report-btn" type="button" onClick={downloadCurrentUserReport}>📥 Download Report</button>
            </div>
            {pointChart.every((item) => item.value === 0) ? (
              <div className="empty-chart-msg">📭 No data yet - start studying to see your progress here!</div>
            ) : (
              <div className="chart-container">
                <svg viewBox="0 0 700 160" className="progress-chart">
                  <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  {dayKeys.map((key, index) => (
                    <text key={key} x={index * 100 + 50} y={155} fontSize="11" fill="var(--color-text-muted)" textAnchor="middle">{getDayLabel(key)}</text>
                  ))}
                  <polyline
                    fill="url(#chartGrad)"
                    points={[...pointChart.map((item, index) => `${index * 100 + 50},${130 - (item.value / maxPts) * 110}`), "650,130", "50,130"].join(" ")}
                  />
                  <polyline
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={pointChart.map((item, index) => `${index * 100 + 50},${130 - (item.value / maxPts) * 110}`).join(" ")}
                  />
                  {pointChart.map((item, index) => (
                    <g key={item.key}>
                      <circle cx={index * 100 + 50} cy={130 - (item.value / maxPts) * 110} r="5" fill="var(--color-accent)" />
                      {item.value > 0 ? <text x={index * 100 + 50} y={130 - (item.value / maxPts) * 110 - 10} fontSize="10" fill="var(--color-accent)" textAnchor="middle">{item.value}</text> : null}
                    </g>
                  ))}
                </svg>
              </div>
            )}
          </div>

          <div className="card-subsection">
            <h3 className="card-subheading">⏱️ Study Time - Last 7 Days</h3>
            {minuteChart.every((item) => item.value === 0) ? (
              <div className="empty-chart-msg">📭 Complete scheduled sessions to track your study time!</div>
            ) : (
              <div className="chart-container">
                <div className="bar-chart">
                  {minuteChart.map((item) => (
                    <div key={item.key} className="bar-col">
                      <div className="bar-value">{item.value > 0 ? formatMinutes(item.value) : ""}</div>
                      <div className="bar-fill" style={{ height: `${Math.max(4, (item.value / maxMins) * 100)}%` }} />
                      <div className="bar-label">{item.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card-subsection">
            <h3 className="card-subheading">📋 Progress Summary</h3>
            <div className="report-summary-card">
              <p>{`You have earned ${currentProgress.points || 0} points and built a ${currentProgress.streak || 0}-day streak.`}</p>
              <p>{`Your total study time is ${totalStudyTime}, with ${currentProgress.quizzes_completed || 0} quizzes completed.`}</p>
              <p>{accuracy !== "—" ? `Estimated quiz accuracy: ${accuracy}.` : "Keep completing quizzes to unlock more insights."}</p>
            </div>
          </div>

          {subjectData.length > 0 ? (
            <div className="card-subsection">
              <h3 className="card-subheading">📚 Subject Breakdown</h3>
              <div className="subjects-grid">
                {subjectData.map(([subject, mins], index) => {
                  const colors = ["#4f7cff", "#06d6a0", "#ffd166", "#ff6b6b", "#ce93d8", "#f48fb1"];
                  const maxSubjectMinutes = Math.max(...subjectData.map((entry) => Number(entry[1] || 0)), 1);
                  return (
                    <div key={subject} className="subject-card" style={{ borderLeftColor: colors[index % colors.length] }}>
                      <div className="subject-name">{subject}</div>
                      <div className="subject-stat">{formatMinutes(mins)} studied</div>
                      <div className="subject-bar-wrap">
                        <div className="subject-bar" style={{ width: `${Math.min(100, (Number(mins || 0) / maxSubjectMinutes) * 100)}%`, background: colors[index % colors.length] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="card-subsection">
            <h3 className="card-subheading">🏅 Badges - {earnedCount}/{badgeSummary.achieved.length + badgeSummary.locked.length} earned</h3>
            <div className="dashboard-medal-grid">
              {badgeSummary.achieved.map((badge) => (
                <BadgeCard key={badge.id} badge={badge} achieved metrics={metrics} onClick={() => handleBadgeClick(badge, true)} />
              ))}
              {badgeSummary.locked.map((badge) => (
                <BadgeCard key={badge.id} badge={badge} achieved={false} metrics={metrics} onClick={() => handleBadgeClick(badge, false)} />
              ))}
            </div>
          </div>

          <div className="card-subsection">
            <h3 className="card-subheading">📋 Activity Summary</h3>
            <div className="activity-grid">
              {[
                ["🎯", "Quizzes Done", currentProgress.quizzes_completed || 0],
                ["📅", "Sessions Done", metrics.sessionsCompleted || 0],
                ["✏️", "Simplify Used", mode === "guest" ? guestStats?.simplifiesUsed || 0 : 0],
                ["🎮", "Games Played", mode === "guest" ? guestStats?.gamesPlayed || 0 : 0],
                ["📖", "Stories Read", mode === "guest" ? guestStats?.storiesRead || 0 : 0],
                ["📆", "Days Used", mode === "guest" ? guestStats?.totalDaysUsed || 0 : 0],
              ].map(([icon, label, value]) => (
                <div key={label} className="activity-item">
                  <div className="activity-icon">{icon}</div>
                  <div className="activity-val">{value}</div>
                  <div className="activity-label">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <DashboardAssignmentsSection
            assignments={assignments}
            selfGoals={selfGoals}
            onView={handleViewAssignment}
            onToggleStatus={updateAssignmentStatus}
            onOpenGoalEditor={(goal) => {
              setGoalEditor(goal);
              setGoalForm(goal ? {
                title: goal.title || "",
                description: goal.description || "",
                due_date: goal.due_date || "",
                priority: goal.priority || "",
              } : EMPTY_GOAL_FORM);
            }}
            onDeleteGoal={deleteGoal}
            mode={mode}
          />

          <div className="actions-row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn-primary" type="button" onClick={downloadCurrentUserReport}>📥 Download Report</button>
            {mode === "guest" ? <button className="btn-ghost" type="button" onClick={() => setShowResetConfirm(true)}>🔄 Reset Stats</button> : null}
          </div>
          {showResetConfirm ? (
            <div className="reset-confirm">
              ⚠️ This will clear all your progress data. Are you sure?
              <button className="btn-secondary btn-sm" style={{ marginLeft: 10 }} type="button" onClick={resetGuestStats}>Yes, Reset</button>
              <button className="btn-ghost btn-sm" style={{ marginLeft: 6 }} type="button" onClick={() => setShowResetConfirm(false)}>Cancel</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {view === "parent" ? (
        <div className="report-view">
          <div className="report-welcome">
            <h3>👪 Parent View</h3>
            <p className="card-subtitle">Track your child&apos;s learning progress and achievements.</p>
          </div>
          <div className="stats-grid">
            <div className="stat-card stat-points"><div className="stat-kicker">⭐</div><div className="stat-value">{currentProgress.points || 0}</div><div className="stat-label">Points</div></div>
            <div className="stat-card stat-streak"><div className="stat-kicker">🔥</div><div className="stat-value">{currentProgress.streak || 0}</div><div className="stat-label">Streak</div></div>
            <div className="stat-card stat-time"><div className="stat-kicker">⏰</div><div className="stat-value">{totalStudyTime}</div><div className="stat-label">Study Time</div></div>
            <div className="stat-card stat-accuracy"><div className="stat-kicker">🎯</div><div className="stat-value">{currentProgress.quizzes_completed || 0}</div><div className="stat-label">Quizzes</div></div>
          </div>
          <div className="report-summary-card">
            <h4>📋 Weekly Summary</h4>
            {(mode === "guest" ? guestStats?.totalDaysUsed : currentProgress.points || currentProgress.quizzes_completed) ? (
              <>
                <p>{`This learner has earned ${currentProgress.points || 0} points and completed ${currentProgress.quizzes_completed || 0} quizzes.`}</p>
                <p>{`They studied for ${totalStudyTime} and currently have a ${currentProgress.streak || 0}-day streak.`}</p>
                <p>{currentProgress.streak >= 3 ? "Excellent consistency! 🌟" : "Encourage daily study to build a stronger streak."}</p>
              </>
            ) : (
              <p>No activity yet! Encourage your child to start their first study session. 🚀</p>
            )}
          </div>
          <button className="btn-primary" type="button" onClick={downloadCurrentUserReport}>📥 Download Full Report</button>
        </div>
      ) : null}

      {view === "mentor" ? (
        <div className="report-view">
          <div className="report-welcome">
            <h3>🎓 Mentor Insights</h3>
            <p className="card-subtitle">Detailed analytics to support the learner.</p>
          </div>
          <div className="subjects-grid">
            {subjectData.length > 0 ? subjectData.map(([subject, mins]) => (
              <div key={subject} className="subject-card">
                <div className="subject-name">{subject}</div>
                <div className="subject-stat">{formatMinutes(mins)} studied</div>
                <div className="accuracy-bar">
                  <div className="accuracy-fill" style={{ width: `${Math.min(100, (Number(mins || 0) / Math.max(...subjectData.map((entry) => Number(entry[1] || 0)), 1)) * 100)}%` }} />
                </div>
              </div>
            )) : (
              <div className="empty-chart-msg" style={{ gridColumn: "1 / -1" }}>No subject data yet - the learner needs to complete more study sessions.</div>
            )}
          </div>
          <div className="report-summary-card">
            <h4>🔍 Learning Analysis</h4>
            {(metrics.sessionsCompleted || currentProgress.quizzes_completed || currentProgress.points) ? (
              <>
                <p>{`The learner has studied for ${totalStudyTime} and completed ${currentProgress.quizzes_completed || 0} quizzes.`}</p>
                <p>{`Current streak: ${currentProgress.streak || 0} days. Points earned: ${currentProgress.points || 0}.`}</p>
                <p>{currentProgress.streak >= 5 ? "Strong daily consistency - study habits are improving well." : "Encourage more consistent study sessions to strengthen the learner's routine."}</p>
              </>
            ) : (
              <p>The learner has not yet completed enough study activity to generate insights.</p>
            )}
          </div>
          <button className="btn-primary" type="button" onClick={downloadCurrentUserReport}>📥 Download Mentor Report</button>
        </div>
      ) : null}

      {goalEditor !== null ? (
        <div className="badge-preview-overlay" role="presentation" onClick={() => setGoalEditor(null)}>
          <div className="badge-preview-card goal-editor-dialog" role="dialog" aria-modal="true" aria-label="Goal editor" onClick={(event) => event.stopPropagation()}>
            <div className="goal-editor-form">
              <h3>{goalEditor?.id ? "Edit Goal" : "Add Self Goal"}</h3>
              <label className="user-account-field">
                <span>Title</span>
                <input value={goalForm.title} onChange={(event) => setGoalForm((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label className="user-account-field">
                <span>Description</span>
                <textarea value={goalForm.description} onChange={(event) => setGoalForm((current) => ({ ...current, description: event.target.value }))} />
              </label>
              <div className="password-row">
                <label className="user-account-field">
                  <span>Due Date</span>
                  <input type="date" value={goalForm.due_date} onChange={(event) => setGoalForm((current) => ({ ...current, due_date: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Priority</span>
                  <input value={goalForm.priority} onChange={(event) => setGoalForm((current) => ({ ...current, priority: event.target.value }))} />
                </label>
              </div>
            </div>
            <div className="account-settings-actions goal-editor-actions">
              <button className="btn-primary" type="button" onClick={saveGoal}>Save</button>
              <button className="btn-ghost" type="button" onClick={() => { setGoalEditor(null); setGoalForm(EMPTY_GOAL_FORM); }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      <BadgePreviewModal
        badge={badgeModal?.badge}
        achieved={badgeModal?.achieved}
        metrics={metrics}
        onClose={() => setBadgeModal(null)}
      />
      <AssignmentNoticeModal
        items={assignmentNoticeItems}
        onView={handleNoticeView}
        onLater={() => setAssignmentNoticeItems([])}
        onMarkSeen={markNoticesSeen}
      />
      <AssignmentReminderModal
        items={assignmentReminderItems}
        onView={(assignmentId) => {
          dismissRemindersForToday();
          const match = assignments.find((item) => item.id === assignmentId);
          if (match) handleViewAssignment(match);
        }}
        onDismiss={dismissRemindersForToday}
      />
    </div>
  );
}

function MentorLearnerCard({
  learner,
  expanded,
  onToggle,
  onDownloadReport,
}) {
  const metrics = buildMetrics(learner.progress || EMPTY_PROGRESS, "account", { user: { preferences_json: learner.metadata || {} } });
  const badgeSummary = buildBadgeSummary(metrics);
  const headerLabel = expanded
    ? `${learner.learner_name} - ${learner.class?.name || learner.class_level || "Class not set"}`
    : learner.learner_name;
  return (
    <article className="card managed-student-dashboard-card mentor-learner-card">
      <div className={`mentor-learner-row ${expanded ? "mentor-learner-row-sticky" : ""}`} onClick={() => onToggle(learner.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onToggle(learner.id); }} role="button" tabIndex={0}>
        <div className={`mentor-learner-main ${expanded ? "mentor-learner-main-expanded" : ""}`}>
          <strong>{headerLabel}</strong>
          {!expanded ? <span>{learner.class?.name || learner.class_level || "Class not set"}</span> : null}
        </div>
        <div className="mentor-learner-actions">
          <button className="btn-primary dashboard-report-btn" type="button" onClick={(event) => { event.stopPropagation(); onDownloadReport(learner); }}>
            Download Report
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mentor-learner-expanded">
          <div className="mentor-learner-detail-grid managed-student-detail-grid">
            <div className="managed-student-summary-chip"><strong>Age</strong><span>{learner.learner_age || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Gender</strong><span>{learner.metadata?.gender || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Class</strong><span>{learner.class?.name || learner.class_level || "Class not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Student Email</strong><span>{learner.metadata?.student_email || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Parent/Guardian Email</strong><span>{learner.metadata?.parent_guardian_email || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Learning Goal</strong><span>{learner.metadata?.learning_goal || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Preferred Subjects</strong><span>{(learner.metadata?.preferred_subjects || []).join(", ") || "Not set"}</span></div>
            <div className="managed-student-summary-chip"><strong>Daily Target</strong><span>{learner.metadata?.daily_study_target_minutes ? `${learner.metadata.daily_study_target_minutes} minutes` : "Not set"}</span></div>
          </div>

          <div className="stats-grid managed-student-stats">
            <StatCard value={learner.progress?.points || 0} label="Points" accentClass="stat-accent-yellow" />
            <StatCard value={learner.progress?.streak || 0} label="Streak" accentClass="stat-accent-red" />
            <StatCard value={`${learner.progress?.study_minutes || 0}m`} label="Minutes" accentClass="stat-accent-blue" />
            <StatCard value={learner.progress?.quizzes_completed || 0} label="Quiz" accentClass="stat-accent-green" />
          </div>

          <div className="managed-student-badges">
            <h4 className="card-subheading">Badges Summary</h4>
            <div className="dashboard-medal-grid">
              {badgeSummary.achieved.slice(0, 4).map((badge) => (
                <BadgeCard key={`${learner.id}-${badge.id}`} badge={badge} achieved metrics={metrics} onClick={() => {}} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function MentorDashboard({ authSession, mentorSection }) {
  const [learners, setLearners] = useState([]);
  const [classes, setClasses] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [badgeModal, setBadgeModal] = useState(null);
  const [expandedLearnerId, setExpandedLearnerId] = useState(null);
  const [classDrafts, setClassDrafts] = useState({});
  const [classModal, setClassModal] = useState(null);
  const [classForm, setClassForm] = useState(EMPTY_CLASS_FORM);
  const [editingClassId, setEditingClassId] = useState(null);
  const [assignmentForm, setAssignmentForm] = useState(EMPTY_ASSIGNMENT_FORM);
  const [editingAssignmentId, setEditingAssignmentId] = useState(null);
  const [assignmentDeleteId, setAssignmentDeleteId] = useState(null);
  const [assignmentDetails, setAssignmentDetails] = useState(null);
  const [assignmentGrades, setAssignmentGrades] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function loadMentorData() {
      try {
        const [nextLearners, nextClasses, nextAssignments] = await Promise.all([
          apiFetch("/managed-students"),
          apiFetch("/mentor/classes"),
          apiFetch("/mentor/assignments"),
        ]);
        if (cancelled) return;
        setLearners(nextLearners);
        setClasses(nextClasses);
        setAssignments(nextAssignments);
      } catch (error) {
        openToast(error.message || "Could not load mentor dashboard.", "error");
      }
    }
    loadMentorData();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshMentorData() {
    const [nextLearners, nextClasses, nextAssignments] = await Promise.all([
      apiFetch("/managed-students"),
      apiFetch("/mentor/classes"),
      apiFetch("/mentor/assignments"),
    ]);
    setLearners(nextLearners);
    setClasses(nextClasses);
    setAssignments(nextAssignments);
  }

  async function downloadLearnerReport(learner) {
    try {
      const report = await apiFetch(`/students/${learner.id}/report`);
      downloadTextReport(report.filename, report.report_text);
    } catch (error) {
      openToast(error.message || "Could not download report.", "error");
    }
  }

  function stageClassChange(learner, classId) {
    setClassDrafts((current) => ({ ...current, [learner.id]: classId }));
    setClassModal({ learner, class_id: classId });
  }

  async function confirmClassAssignment() {
    if (!classModal) return;
    try {
      await apiFetch(`/mentor/learners/${classModal.learner.id}/class`, withJsonBody("PUT", {
        class_id: classModal.class_id ? Number(classModal.class_id) : null,
      }));
      openToast("Class assigned successfully.", "success");
      setClassModal(null);
      await refreshMentorData();
    } catch (error) {
      openToast(error.message || "Class assignment failed.", "error");
    }
  }

  async function saveClass() {
    const payload = {
      name: classForm.name,
      description: classForm.description,
      subject: classForm.subject,
      grade_level: classForm.grade_level,
    };
    try {
      if (editingClassId) {
        await apiFetch(`/mentor/classes/${editingClassId}`, withJsonBody("PUT", payload));
      } else {
        await apiFetch("/mentor/classes", withJsonBody("POST", payload));
      }
      setClassForm(EMPTY_CLASS_FORM);
      setEditingClassId(null);
      await refreshMentorData();
    } catch (error) {
      openToast(error.message || "Could not save class.", "error");
    }
  }

  async function deleteClass(classId) {
    try {
      await apiFetch(`/mentor/classes/${classId}`, { method: "DELETE" });
      await refreshMentorData();
    } catch (error) {
      openToast(error.message || "Could not delete class.", "error");
    }
  }

  async function saveAssignment() {
    const today = getLocalDateInputValue();
    if (assignmentForm.due_date && assignmentForm.due_date < today) {
      openToast("Assignment due date cannot be before today.", "error");
      return;
    }
    const payload = {
      title: assignmentForm.title,
      description: assignmentForm.description,
      due_date: assignmentForm.due_date || null,
      priority: assignmentForm.priority || "",
      assign_to_all: assignmentForm.target_mode === "all",
      class_id: assignmentForm.target_mode === "class" && assignmentForm.class_id ? Number(assignmentForm.class_id) : null,
      student_ids: assignmentForm.target_mode === "one" ? assignmentForm.student_ids.map((value) => Number(value)) : [],
    };
    try {
      if (editingAssignmentId) {
        await apiFetch(`/mentor/assignments/${editingAssignmentId}`, withJsonBody("PUT", payload));
      } else {
        await apiFetch("/mentor/assignments", withJsonBody("POST", payload));
      }
      setAssignmentForm(EMPTY_ASSIGNMENT_FORM);
      setEditingAssignmentId(null);
      await refreshMentorData();
    } catch (error) {
      openToast(error.message || "Could not save assignment.", "error");
    }
  }

  async function deleteAssignment() {
    if (!assignmentDeleteId) return;
    try {
      await apiFetch(`/mentor/assignments/${assignmentDeleteId}`, { method: "DELETE" });
      setAssignmentDeleteId(null);
      await refreshMentorData();
    } catch (error) {
      openToast(error.message || "Could not delete assignment.", "error");
    }
  }

  async function openAssignmentDetails(assignment) {
    try {
      const response = await apiFetch(`/mentor/assignments/${assignment.id}`);
      setAssignmentDetails(response);
      const nextDraft = {};
      response.targets.forEach((target) => {
        nextDraft[target.student_id] = {
          marks_obtained: target.marks_obtained ?? "",
          max_marks: target.max_marks ?? "",
          feedback: target.feedback || "",
        };
      });
      setAssignmentGrades(nextDraft);
    } catch (error) {
      openToast(error.message || "Could not open assignment details.", "error");
    }
  }

  async function saveGrade(studentId) {
    if (!assignmentDetails) return;
    const draft = assignmentGrades[studentId] || {};
    const marksObtained = draft.marks_obtained === "" ? null : Number(draft.marks_obtained);
    const maxMarks = draft.max_marks === "" ? null : Number(draft.max_marks);
    if (marksObtained !== null && maxMarks !== null && marksObtained > maxMarks) {
      openToast("Marks obtained cannot be greater than maximum marks.", "error");
      return;
    }
    try {
      const response = await apiFetch(
        `/mentor/assignments/${assignmentDetails.id}/targets/${studentId}/grade`,
        withJsonBody("PUT", {
          marks_obtained: marksObtained,
          max_marks: maxMarks,
          feedback: draft.feedback || "",
        }),
      );
      setAssignmentDetails(response.assignment);
      setAssignments((current) => current.map((item) => (item.id === response.assignment.id ? response.assignment : item)));
      openToast("Marks saved.", "success");
    } catch (error) {
      openToast(error.message || "Could not save marks.", "error");
    }
  }

  const mentorName = authSession?.user?.display_name || authSession?.user?.email || "Mentor";

  return (
    <div className="dashboard-page mentor-dashboard-page">
      <div className="page-header">
        <div>
          <h2 className="card-title">Mentor Dashboard</h2>
          <p className="card-subtitle">Track learners, reports, classes, and assignments in one place.</p>
        </div>
      </div>

      {mentorSection === "dashboard" ? (
        <section className="card mentor-dashboard-section">
          <h3 className="card-subheading">Managed Learners</h3>
          <p className="account-settings-meta">Only learner records linked to your mentor account appear here.</p>
          <div className="dashboard-managed-list">
            {!learners.length ? <p className="account-settings-meta">No learners linked yet.</p> : null}
            {learners.map((learner) => (
              <RefinedMentorLearnerCard
                key={learner.id}
                learner={learner}
                expanded={expandedLearnerId === learner.id}
                onToggle={(id) => setExpandedLearnerId((current) => (current === id ? null : id))}
                onDownloadReport={downloadLearnerReport}
                assignments={assignments}
                onBadgeClick={(badge, achieved, metrics) => setBadgeModal({ badge, achieved, metrics })}
              />
            ))}
          </div>
        </section>
      ) : null}

      {mentorSection === "classes" ? (
        <section className="card mentor-dashboard-section">
          <div className="managed-students-dashboard-head">
            <div>
              <h3 className="card-subheading">Classes</h3>
              <p className="account-settings-meta">Create, update, and organize classes for your learners.</p>
            </div>
          </div>
          <div className="account-settings-form class-management-form">
            <label className="user-account-field">
              <span>Class name</span>
              <input value={classForm.name} onChange={(event) => setClassForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="user-account-field">
              <span>Subject</span>
              <input value={classForm.subject} onChange={(event) => setClassForm((current) => ({ ...current, subject: event.target.value }))} />
            </label>
            <label className="user-account-field">
              <span>Grade / level</span>
              <input value={classForm.grade_level} onChange={(event) => setClassForm((current) => ({ ...current, grade_level: event.target.value }))} />
            </label>
            <label className="user-account-field account-settings-field-wide">
              <span>Description</span>
              <textarea value={classForm.description} onChange={(event) => setClassForm((current) => ({ ...current, description: event.target.value }))} />
            </label>
          </div>
          <div className="account-settings-actions">
            <button className="btn-primary" type="button" onClick={saveClass}>{editingClassId ? "Save Class" : "Create Class"}</button>
            {editingClassId ? <button className="btn-ghost" type="button" onClick={() => { setEditingClassId(null); setClassForm(EMPTY_CLASS_FORM); }}>Cancel</button> : null}
          </div>

          <div className="class-management-list">
            {!classes.length ? <p className="account-settings-meta">No classes yet.</p> : null}
            {classes.map((item) => (
              <article className="card class-card" key={item.id}>
                <div className="class-card-copy">
                  <strong>{item.name}</strong>
                  <span>{item.subject || "No subject set"}</span>
                  <span>{item.grade_level || "No grade level set"}</span>
                  <span>{`${learners.filter((learner) => String(learner.class?.id || "") === String(item.id)).length} learner(s)`}</span>
                  <p className="class-card-description">{item.description || "No description added yet."}</p>
                </div>
                <div className="account-settings-actions class-card-actions">
                  <button className="btn-ghost" type="button" onClick={() => { setEditingClassId(item.id); setClassForm({ name: item.name, description: item.description || "", subject: item.subject || "", grade_level: item.grade_level || "" }); }}>Edit</button>
                  <button className="btn-ghost" type="button" onClick={() => deleteClass(item.id)}>Delete</button>
                </div>
              </article>
            ))}
          </div>

          <div className="class-management-assignment-panel">
            <div>
              <h4 className="card-subheading">Learner Class Mapping</h4>
              <p className="account-settings-meta">Change learner classes only here.</p>
            </div>
            <div className="class-management-assignment-list">
              {!learners.length ? <p className="account-settings-meta">No learners linked yet.</p> : null}
              {learners.map((learner) => {
                const selectedClassId = classDrafts[learner.id] ?? (learner.class?.id ? String(learner.class.id) : "");
                return (
                  <article className="card class-assignment-row" key={`class-map-${learner.id}`}>
                    <div className="class-assignment-row-copy">
                      <strong>{learner.learner_name}</strong>
                      <span>{learner.class?.name || learner.class_level || "Class not set"}</span>
                    </div>
                    <label className="user-account-field mentor-class-select">
                      <span>Class</span>
                      <select value={selectedClassId} onChange={(event) => stageClassChange(learner, event.target.value)}>
                        <option value="">Class not set</option>
                        {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}

      {mentorSection === "assignments" ? (
        <section className="card mentor-dashboard-section mentor-assignments-section">
          <h3 className="card-subheading">Assignments</h3>
          <div className="account-settings-form assignment-form-grid">
            <label className="user-account-field">
              <span>Title</span>
              <input value={assignmentForm.title} onChange={(event) => setAssignmentForm((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label className="user-account-field">
              <span>Due date</span>
              <input type="date" min={getLocalDateInputValue()} value={assignmentForm.due_date} onChange={(event) => setAssignmentForm((current) => ({ ...current, due_date: event.target.value }))} />
            </label>
            <label className="user-account-field account-settings-field-wide">
              <span>Description</span>
              <textarea value={assignmentForm.description} onChange={(event) => setAssignmentForm((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label className="user-account-field">
              <span>Assign to</span>
              <select value={assignmentForm.target_mode} onChange={(event) => setAssignmentForm((current) => ({ ...current, target_mode: event.target.value, student_ids: [], class_id: "" }))}>
                <option value="all">All learners</option>
                <option value="one">One learner</option>
                <option value="class">One class</option>
              </select>
            </label>
            {assignmentForm.target_mode === "one" ? (
              <label className="user-account-field">
                <span>Learner</span>
                <select value={assignmentForm.student_ids[0] || ""} onChange={(event) => setAssignmentForm((current) => ({ ...current, student_ids: event.target.value ? [event.target.value] : [] }))}>
                  <option value="">Select learner</option>
                  {learners.map((learner) => <option key={learner.id} value={learner.id}>{learner.learner_name}</option>)}
                </select>
              </label>
            ) : null}
            {assignmentForm.target_mode === "class" ? (
              <label className="user-account-field">
                <span>Class</span>
                <select value={assignmentForm.class_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, class_id: event.target.value }))}>
                  <option value="">Select class</option>
                  {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          <div className="account-settings-actions">
            <button className="btn-primary" type="button" onClick={saveAssignment}>{editingAssignmentId ? "Save Assignment" : "Create Assignment"}</button>
            {editingAssignmentId ? <button className="btn-ghost" type="button" onClick={() => { setEditingAssignmentId(null); setAssignmentForm(EMPTY_ASSIGNMENT_FORM); }}>Cancel</button> : null}
          </div>

          <div className="dashboard-assignment-group">
            {!assignments.length ? <p className="account-settings-meta">No assignments yet.</p> : null}
            {assignments.map((assignment) => (
              <article className="card assignment-card mentor-assignment-list-card" key={assignment.id} onClick={() => openAssignmentDetails(assignment)}>
                <div className="mentor-assignment-list-head">
                  <div className="mentor-assignment-list-copy">
                    <strong>{assignment.title}</strong>
                  </div>
                  <div className="assignment-card-actions mentor-assignment-list-actions">
                    <button className="btn-ghost" type="button" onClick={(event) => { event.stopPropagation(); openAssignmentDetails(assignment); }}>View Details</button>
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingAssignmentId(assignment.id);
                        setAssignmentForm({
                          title: assignment.title,
                          description: assignment.description || "",
                          due_date: assignment.due_date || "",
                          priority: assignment.priority || "",
                          target_mode: assignment.class_id ? "class" : assignment.targets.length === learners.length ? "all" : "one",
                          class_id: assignment.class_id ? String(assignment.class_id) : "",
                          student_ids: assignment.class_id ? [] : assignment.targets.map((target) => String(target.student_id)),
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button className="btn-ghost" type="button" onClick={(event) => { event.stopPropagation(); setAssignmentDeleteId(assignment.id); }}>Delete</button>
                  </div>
                </div>
                <p className="assignment-description">{assignment.description || "No description added yet."}</p>
                <div className="assignment-meta-list">
                  <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
                  <span>{assignment.class_name ? `Class: ${assignment.class_name}` : `${assignment.assigned_count} learner(s)`}</span>
                  <span>{`${assignment.completed_count} completed • ${assignment.pending_count} pending`}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <ClassAssignmentModal
        draft={classModal}
        learner={classModal?.learner}
        classes={classes}
        mentorName={mentorName}
        onConfirm={confirmClassAssignment}
        onCancel={() => setClassModal(null)}
      />
      <DeleteConfirmModal
        title={assignmentDeleteId ? "Delete Assignment" : ""}
        copy="Are you sure you want to delete this assignment?"
        confirmLabel="Delete Assignment"
        onConfirm={deleteAssignment}
        onCancel={() => setAssignmentDeleteId(null)}
      />
      <MentorAssignmentDetailModal
        assignment={assignmentDetails}
        onClose={() => setAssignmentDetails(null)}
        gradesDraft={assignmentGrades}
        onGradeChange={(studentId, field, value) => {
          setAssignmentGrades((current) => ({
            ...current,
            [studentId]: {
              ...(current[studentId] || {}),
              [field]: value,
            },
          }));
        }}
        onSaveGrade={saveGrade}
      />
      <RefinedBadgePreviewModal
        badge={badgeModal?.badge}
        achieved={badgeModal?.achieved}
        metrics={badgeModal?.metrics}
        onClose={() => setBadgeModal(null)}
      />
    </div>
  );
}

function getRefinedBadgeNarrative(badge, metrics = {}, achieved) {
  const progress = getBadgeProgress(badge.id, metrics);
  const unit = progress.unit.endsWith("s") ? progress.unit : `${progress.unit}${progress.target === 1 ? "" : "s"}`;
  const currentValueText = `${progress.current} / ${progress.target} ${unit}`;
  const remaining = Math.max(progress.target - progress.current, 0);
  const earnedDateSource = metrics.updated_at || metrics.lastActive || null;
  return achieved
    ? {
      about: badge.description,
      detail: `You earned this badge by completing this milestone: ${badge.description}`,
      earnedText: earnedDateSource ? formatReadableDate(earnedDateSource, { includeTime: true }) : "Recently",
      progressText: currentValueText,
    }
    : {
      about: badge.description,
      detail: `${badge.description.charAt(0).toUpperCase()}${badge.description.slice(1)}`,
      progressText: currentValueText,
      remainingText: remaining ? `${remaining} ${unit}` : "Ready to unlock",
    };
}

function RefinedStatCard({ value, label, icon, accentClass = "" }) {
  return (
    <article className={`stat-card ${accentClass}`.trim()}>
      <div className="stat-emoji" aria-hidden="true">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-kicker">{label}</div>
    </article>
  );
}

function RefinedBadgeCard({ badge, achieved, metrics, onClick }) {
  return (
    <button
      type="button"
      className={`badge-medal-card ${achieved ? "badge-medal-card-active" : "badge-medal-card-locked"}`.trim()}
      onClick={onClick}
    >
      <div className="badge-medal-shell">
        <img
          src={BADGE_IMAGE_MAP[badge.id]}
          alt={badge.label}
          className={`badge-medal-image ${achieved ? "" : "badge-preview-image-locked"}`.trim()}
        />
        {!achieved ? <span className="badge-medal-lock">Locked</span> : null}
      </div>
      <div className="badge-medal-copy">
        <strong>{badge.label}</strong>
        <span>{achieved ? "Achieved" : "Locked"}</span>
      </div>
    </button>
  );
}

function RefinedBadgePreviewModal({ badge, achieved, metrics, onClose }) {
  useEffect(() => {
    if (!badge) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [badge, onClose]);

  if (!badge) return null;
  const narrative = getRefinedBadgeNarrative(badge, metrics, achieved);
  return (
    <div className="badge-preview-overlay" onClick={onClose} role="presentation">
      <div
        className={`badge-preview-card ${achieved ? "" : "badge-preview-card-locked"}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={badge.label}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="badge-preview-close" type="button" onClick={onClose} aria-label="Close badge details" />
        <div className="badge-preview-image-wrap">
          <img
            src={BADGE_IMAGE_MAP[badge.id]}
            alt={badge.label}
            className={`badge-preview-image ${achieved ? "" : "badge-preview-image-locked"}`.trim()}
          />
        </div>
        <div className="badge-preview-copy">
          <h3>{badge.label}</h3>
          <div className="badge-preview-meta badge-preview-meta-structured">
            <div><strong>Badge</strong><span>{badge.label}</span></div>
            <div><strong>About</strong><span>{narrative.about}</span></div>
            <div><strong>{achieved ? "How it was earned" : "How to earn it"}</strong><span>{narrative.detail}</span></div>
            {achieved ? <div><strong>Earned on</strong><span>{narrative.earnedText}</span></div> : null}
            <div><strong>Your progress</strong><span>{narrative.progressText}</span></div>
            {!achieved ? <div><strong>Still needed</strong><span>{narrative.remainingText}</span></div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function RefinedDashboardBadges({ achievedBadges, lockedBadges, metrics, onBadgeClick, showLocked = true }) {
  return (
    <>
      <section className="card card-subsection dashboard-badges-section">
        <h3 className="card-subheading">Achieved Badges</h3>
        {achievedBadges.length ? (
          <div className="dashboard-medal-grid">
            {achievedBadges.map((badge) => (
              <RefinedBadgeCard key={`achieved-${badge.id}`} badge={badge} achieved metrics={metrics} onClick={() => onBadgeClick(badge, true, metrics)} />
            ))}
          </div>
        ) : (
          <p className="account-settings-meta">No badges earned yet.</p>
        )}
      </section>

      {showLocked ? (
        <section className="card card-subsection dashboard-badges-section">
          <h3 className="card-subheading">Locked Badges</h3>
          {lockedBadges.length ? (
            <div className="dashboard-medal-grid">
              {lockedBadges.map((badge) => (
                <RefinedBadgeCard key={`locked-${badge.id}`} badge={badge} achieved={false} metrics={metrics} onClick={() => onBadgeClick(badge, false, metrics)} />
              ))}
            </div>
          ) : (
            <p className="account-settings-meta">All badges unlocked.</p>
          )}
        </section>
      ) : null}
    </>
  );
}

function RefinedAssignmentsSection({
  assignments,
  selfGoals,
  mode,
  assignmentRefs,
  onToggleStatus,
  onOpenGoalEditor,
  onDeleteGoal,
}) {
  return (
    <section className="card student-assignments-section">
      <div className="managed-students-dashboard-head">
        <div>
          <h3 className="card-subheading">Assignments</h3>
          <p className="account-settings-meta">Mentor Assigned and Self Goals stay here.</p>
        </div>
        <button className="btn-primary" type="button" onClick={() => onOpenGoalEditor()}>Add Self Goal</button>
      </div>

      <div className="dashboard-assignment-stack">
        <div className="dashboard-assignment-group dashboard-assignment-column">
          <h4 className="card-subheading">Mentor Assigned</h4>
          {!assignments.length ? <p className="account-settings-meta">No mentor assignments yet.</p> : null}
          {assignments.map((assignment) => (
            <article
              className="card assignment-card student-assignment-card"
              id={`assignment-${assignment.id}`}
              key={`student-assignment-${assignment.id}`}
              ref={(node) => {
                if (assignmentRefs) assignmentRefs.current[String(assignment.id)] = node;
              }}
            >
              <div className="student-assignment-head">
                <strong>{assignment.title}</strong>
                <span className={`assignment-status-pill ${assignment.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                  {assignment.status === "completed" ? "Completed" : "Pending"}
                </span>
              </div>
              <div className="student-assignment-body">
                <div className="student-assignment-copy">
                  <p className="assignment-description">{assignment.description || "No description added yet."}</p>
                  <div className="assignment-meta-list">
                    <span>{`Assigned by ${assignment.mentor_name || "Mentor"}`}</span>
                    <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
                    <span>{`Assigned ${formatReadableDate(assignment.assigned_at || assignment.created_at, { includeTime: true })}`}</span>
                    {assignment.max_marks ? <span>{`Marks: ${assignment.marks_obtained ?? 0} / ${assignment.max_marks}`}</span> : null}
                  </div>
                  {assignment.feedback ? <p className="assignment-feedback-note">{`Mentor Feedback: ${assignment.feedback}`}</p> : null}
                </div>
                <div className="student-assignment-actions">
                  <div className="assignment-action-row">
                    {assignment.status !== "completed" ? (
                      <button className="btn-primary" type="button" onClick={() => onToggleStatus(assignment, "completed")}>
                        Mark Completed
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="dashboard-assignment-group dashboard-assignment-column">
          <h4 className="card-subheading">{mode === "guest" ? "My Goals" : "My Goals"}</h4>
          {!selfGoals.length ? <p className="account-settings-meta">No self goals yet.</p> : null}
          {selfGoals.map((goal) => (
            <article className="card assignment-card student-assignment-card" key={`goal-${goal.id}`}>
              <div className="student-assignment-head">
                <strong>{goal.title}</strong>
                <span className={`assignment-status-pill ${goal.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                  {goal.status === "completed" ? "Completed" : "Pending"}
                </span>
              </div>
              <div className="student-assignment-body">
                <div className="student-assignment-copy">
                  <p className="assignment-description">{goal.description || "No description added yet."}</p>
                  <div className="assignment-meta-list">
                    <span>{goal.due_date ? formatDueDateText(goal.due_date) : "No due date"}</span>
                  </div>
                </div>
                <div className="student-assignment-actions">
                  <div className="assignment-action-row">
                    {goal.status !== "completed" ? (
                      <button className="btn-primary" type="button" onClick={() => onToggleStatus(goal, "completed")}>
                        Mark Completed
                      </button>
                    ) : (
                      <button className="btn-ghost" type="button" onClick={() => onToggleStatus(goal, "pending")}>
                        Undo Completion
                      </button>
                    )}
                    <button className="btn-ghost" type="button" onClick={() => onOpenGoalEditor(goal)}>Edit</button>
                    <button className="btn-ghost" type="button" onClick={() => onDeleteGoal(goal)}>Delete</button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function RefinedDashboardActivity({ items }) {
  return (
    <section className="card card-subsection">
      <h3 className="card-subheading">Activity Summary</h3>
      <div className="activity-grid">
        {items.map((item) => (
          <div key={item.label} className="activity-item">
            <div className="activity-icon">{item.icon}</div>
            <div className="activity-val">{item.value}</div>
            <div className="activity-label">{item.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RefinedDashboardProgressSummary({ items }) {
  return (
    <section className="card dashboard-progress-summary">
      <h3 className="card-subheading">Progress Summary</h3>
      <div className="dashboard-progress-summary-grid">
        {items.map((item) => (
          <div key={item.label} className="dashboard-progress-summary-item">
            <span className="dashboard-progress-summary-label">{item.label}</span>
            <strong className="dashboard-progress-summary-value">{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function RefinedPointsChart({ pointChart, dayKeys, maxPts, reportButton = null }) {
  return (
    <section className="card card-subsection">
      <div className="managed-students-dashboard-head">
        <h3 className="card-subheading">Points Earned - Last 7 Days</h3>
        {reportButton}
      </div>
      {pointChart.every((item) => item.value === 0) ? (
        <div className="empty-chart-msg">No activity yet.</div>
      ) : (
        <div className="chart-container">
          <svg viewBox="0 0 700 160" className="progress-chart">
            <defs>
              <linearGradient id="chartGradRefined" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {dayKeys.map((key, index) => (
              <text key={key} x={index * 100 + 50} y={155} fontSize="11" fill="var(--color-text-muted)" textAnchor="middle">{getDayLabel(key)}</text>
            ))}
            <polyline
              fill="url(#chartGradRefined)"
              points={[...pointChart.map((item, index) => `${index * 100 + 50},${130 - (item.value / maxPts) * 110}`), "650,130", "50,130"].join(" ")}
            />
            <polyline
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={pointChart.map((item, index) => `${index * 100 + 50},${130 - (item.value / maxPts) * 110}`).join(" ")}
            />
            {pointChart.map((item, index) => (
              <g key={item.key}>
                <circle cx={index * 100 + 50} cy={130 - (item.value / maxPts) * 110} r="5" fill="var(--color-accent)" />
                {item.value > 0 ? <text x={index * 100 + 50} y={130 - (item.value / maxPts) * 110 - 10} fontSize="10" fill="var(--color-accent)" textAnchor="middle">{item.value}</text> : null}
              </g>
            ))}
          </svg>
        </div>
      )}
    </section>
  );
}

function RefinedStudyTimeChart({ minuteChart, maxMins }) {
  return (
    <section className="card card-subsection">
      <h3 className="card-subheading">Study Time - Last 7 Days</h3>
      {minuteChart.every((item) => item.value === 0) ? (
        <div className="empty-chart-msg">No activity yet.</div>
      ) : (
        <div className="chart-container">
          <div className="bar-chart">
            {minuteChart.map((item) => (
              <div key={item.key} className="bar-col">
                <div className="bar-value">{item.value > 0 ? formatMinutes(item.value) : ""}</div>
                <div className="bar-fill" style={{ height: `${Math.max(4, (item.value / maxMins) * 100)}%` }} />
                <div className="bar-label">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function RefinedSubjectBreakdown({ subjectData }) {
  if (!subjectData.length) return null;
  const maxSubjectMinutes = Math.max(...subjectData.map((entry) => Number(entry[1] || 0)), 1);
  const colors = ["#4f7cff", "#06d6a0", "#ffd166", "#ff6b6b", "#ce93d8", "#f48fb1"];
  return (
    <section className="card card-subsection">
      <h3 className="card-subheading">Subject Breakdown</h3>
      <div className="subjects-grid">
        {subjectData.map(([subject, mins], index) => (
          <div key={subject} className="subject-card" style={{ borderLeftColor: colors[index % colors.length] }}>
            <div className="subject-name">{subject}</div>
            <div className="subject-stat">{formatMinutes(mins)} studied</div>
            <div className="subject-bar-wrap">
              <div className="subject-bar" style={{ width: `${Math.min(100, (Number(mins || 0) / maxSubjectMinutes) * 100)}%`, background: colors[index % colors.length] }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RefinedStudentDashboard({ authSession, mode }) {
  const [progress, setProgress] = useState(mode === "guest" ? null : loadAccountProgress());
  const [assignments, setAssignments] = useState([]);
  const [selfGoals, setSelfGoals] = useState(mode === "guest" ? loadGuestGoals() : []);
  const [badgeModal, setBadgeModal] = useState(null);
  const [goalEditor, setGoalEditor] = useState(null);
  const [goalForm, setGoalForm] = useState(EMPTY_GOAL_FORM);
  const [assignmentNoticeItems, setAssignmentNoticeItems] = useState([]);
  const [assignmentReminderItems, setAssignmentReminderItems] = useState([]);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const assignmentRefs = useRef({});

  const guestStats = mode === "guest" ? loadStats() : null;
  const currentProgress = mode === "guest"
    ? {
      ...EMPTY_PROGRESS,
      points: guestStats?.points || 0,
      streak: guestStats?.streak || 0,
      study_minutes: guestStats?.totalMinutes || 0,
      quizzes_completed: guestStats?.quizzesCompleted || 0,
      daily_points: guestStats?.dailyPoints || {},
      daily_minutes: guestStats?.dailyMinutes || {},
      daily_goal_completed_days: guestStats?.dailyGoalCompletedDays || [],
      updated_at: guestStats?.lastActive || null,
    }
    : { ...EMPTY_PROGRESS, ...(progress || EMPTY_PROGRESS) };

  const metrics = buildMetrics(currentProgress, mode, authSession);
  metrics.updated_at = currentProgress.updated_at;
  metrics.lastActive = guestStats?.lastActive || null;
  const badgeSummary = buildBadgeSummary(metrics);
  const dayKeys = getLast7DayKeys();
  const pointChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyPoints[key] || 0) }));
  const minuteChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyMinutes[key] || 0) }));
  const totalStudyTime = formatMinutes(metrics.studyMinutes || 0);
  const accuracy = currentProgress.quizzes_completed > 0
    ? `${Math.min(99, 70 + Math.floor(currentProgress.quizzes_completed * 1.2))}%`
    : "—";
  const subjectData = Object.entries(metrics.subjectMinutes || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 6);
  const maxPts = Math.max(...pointChart.map((item) => item.value), 1);
  const maxMins = Math.max(...minuteChart.map((item) => item.value), 1);
  function openGoalEditor(goal = null) {
    setGoalEditor(goal || {});
    setGoalForm(goal ? {
      title: goal.title || "",
      description: goal.description || "",
      due_date: goal.due_date || "",
      priority: goal.priority || "",
    } : EMPTY_GOAL_FORM);
  }

  useEffect(() => {
    if (mode === "guest") {
      setAssignments([]);
      setProgress(null);
      setBadgeModal(null);
      setGoalEditor(null);
      setGoalForm(EMPTY_GOAL_FORM);
      setAssignmentNoticeItems([]);
      setAssignmentReminderItems([]);
      setShowResetConfirm(false);
      setSelfGoals(loadGuestGoals());
      assignmentRefs.current = {};
      if (window.location.hash.startsWith("#assignment-")) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      return;
    }
    let cancelled = false;
    async function loadStudentData() {
      try {
        const [nextProgress, mentorAssignments, nextGoals] = await Promise.all([
          fetchAccountProgress(),
          apiFetch("/student/assignments"),
          apiFetch("/student/self-goals"),
        ]);
        if (cancelled) return;
        const normalizedAssignments = mentorAssignments.map(normalizeStudentAssignment);
        setProgress(nextProgress);
        setAssignments(normalizedAssignments);
        setSelfGoals(nextGoals.map(normalizeStudentAssignment));
        setAssignmentNoticeItems(normalizedAssignments.filter((item) => item.status !== "completed" && !item.seen_at));
        const reminderState = readReminderState();
        const todayKey = getTodayKey();
        setAssignmentReminderItems(
          normalizedAssignments.filter((item) => item.status !== "completed" && item.due_date && formatReadableDate(item.due_date) === "tomorrow" && reminderState[`${todayKey}:${item.id}`] !== true),
        );
      } catch (error) {
        openToast(error.message || "Could not load dashboard data.", "error");
      }
    }
    loadStudentData();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    function handleProgressChanged() {
      if (mode === "guest") {
        setSelfGoals(loadGuestGoals());
      }
    }
    window.addEventListener("prepbro:progress-changed", handleProgressChanged);
    return () => window.removeEventListener("prepbro:progress-changed", handleProgressChanged);
  }, [mode]);

  useEffect(() => {
    if (mode === "guest") return;
    if (window.location.hash.startsWith("#assignment-")) {
      const id = window.location.hash.replace("#assignment-", "");
      const node = assignmentRefs.current[id];
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("assignment-card-highlighted");
        window.setTimeout(() => node.classList.remove("assignment-card-highlighted"), 1800);
      }
    }
  }, [assignments, mode]);

  useEffect(() => {
    if (mode === "guest") return;
    if (currentProgress?.daily_goal_completed_days?.length && authSession?.user?.role === "student") {
      const today = getTodayKey();
      const shouldCelebrate = currentProgress.daily_goal_completed_days.includes(today) && !(currentProgress.shown_celebrations || []).includes(today);
      if (shouldCelebrate) {
        openToast("Daily goal completed!", "success");
        markGoalCelebrationShown();
      }
    }
  }, [authSession?.user?.role, currentProgress, mode]);

  function handleBadgeClick(badge, achieved) {
    setBadgeModal({ badge, achieved, metrics });
  }

  function handleViewAssignment(assignment) {
    if (assignment.id) {
      window.history.replaceState({}, "", `#assignment-${assignment.id}`);
      const node = assignmentRefs.current[String(assignment.id)];
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("assignment-card-highlighted");
        window.setTimeout(() => node.classList.remove("assignment-card-highlighted"), 1800);
      }
    }
  }

  async function updateAssignmentStatus(item, status) {
    try {
      if (mode === "guest") {
        const nextGoals = loadGuestGoals().map((goal) => (goal.id === item.id ? { ...goal, status, completed_at: status === "completed" ? new Date().toISOString() : null } : goal));
        saveGuestGoals(nextGoals);
        setSelfGoals(nextGoals);
        return;
      }
      const response = await apiFetch(`/student/assignments/${item.id}/status`, withJsonBody("PUT", { status }));
      if (item.assignment_type === "self_assigned") {
        setSelfGoals((current) => current.map((goal) => (goal.id === item.id ? normalizeStudentAssignment(response.assignment) : goal)));
      } else {
        setAssignments((current) => current.map((assignment) => (assignment.id === item.id ? normalizeStudentAssignment(response.assignment) : assignment)));
      }
    } catch (error) {
      openToast(error.message || "Could not update assignment status.", "error");
    }
  }

  async function saveGoal() {
    const title = goalForm.title.trim();
    if (!title) {
      openToast("Goal title is required.", "error");
      return;
    }
    try {
      if (mode === "guest") {
        const existingGoals = loadGuestGoals();
        if (goalEditor?.id) {
          const updated = existingGoals.map((goal) => (goal.id === goalEditor.id ? { ...goal, ...goalForm } : goal));
          saveGuestGoals(updated);
          setSelfGoals(updated);
        } else {
          const created = [{ id: Date.now(), ...goalForm, status: "pending", assignment_type: "self_assigned", created_at: new Date().toISOString() }, ...existingGoals];
          saveGuestGoals(created);
          setSelfGoals(created);
        }
      } else if (goalEditor?.id) {
        const response = await apiFetch(`/student/self-goals/${goalEditor.id}`, withJsonBody("PUT", goalForm));
        setSelfGoals((current) => current.map((goal) => (goal.id === goalEditor.id ? normalizeStudentAssignment(response.goal) : goal)));
      } else {
        const response = await apiFetch("/student/self-goals", withJsonBody("POST", goalForm));
        setSelfGoals((current) => [normalizeStudentAssignment(response.goal), ...current]);
      }
      setGoalEditor(null);
      setGoalForm(EMPTY_GOAL_FORM);
    } catch (error) {
      openToast(error.message || "Could not save goal.", "error");
    }
  }

  async function deleteGoal(goal) {
    try {
      if (mode === "guest") {
        const nextGoals = loadGuestGoals().filter((item) => item.id !== goal.id);
        saveGuestGoals(nextGoals);
        setSelfGoals(nextGoals);
      } else {
        await apiFetch(`/student/self-goals/${goal.id}`, { method: "DELETE" });
        setSelfGoals((current) => current.filter((item) => item.id !== goal.id));
      }
    } catch (error) {
      openToast(error.message || "Could not delete goal.", "error");
    }
  }

  async function markNoticesSeen() {
    if (!assignmentNoticeItems.length) return;
    try {
      await Promise.all(assignmentNoticeItems.map((item) => apiFetch(`/student/assignments/${item.id}/seen`, withJsonBody("PUT", { seen: true }))));
      setAssignments((current) => current.map((item) => (assignmentNoticeItems.some((notice) => notice.id === item.id) ? { ...item, seen_at: new Date().toISOString() } : item)));
      setAssignmentNoticeItems([]);
    } catch (error) {
      openToast(error.message || "Could not update assignment notices.", "error");
    }
  }

  function dismissRemindersForToday() {
    const todayKey = getTodayKey();
    const state = readReminderState();
    assignmentReminderItems.forEach((item) => {
      state[`${todayKey}:${item.id}`] = true;
    });
    writeReminderState(state);
    setAssignmentReminderItems([]);
  }

  async function handleNoticeView(assignmentId) {
    const chosen = assignments.find((item) => item.id === assignmentId);
    if (!chosen) {
      setAssignmentNoticeItems([]);
      return;
    }
    await apiFetch(`/student/assignments/${assignmentId}/seen`, withJsonBody("PUT", { seen: true }));
    setAssignments((current) => current.map((item) => (item.id === assignmentId ? { ...item, seen_at: new Date().toISOString() } : item)));
    setAssignmentNoticeItems((current) => current.filter((item) => item.id !== assignmentId));
    handleViewAssignment({ ...chosen, seen_at: new Date().toISOString() });
  }

  async function downloadCurrentUserReport() {
    if (mode === "guest") {
      const guest = loadGuestProfile() || {};
      downloadTextReport(
        "prepbro_guest_report.txt",
        [
          "PrepBro Student Report",
          `Student: ${guest.display_name || "Guest"}`,
          `Age: ${guest.age || "Not set"}`,
          `Points: ${currentProgress.points}`,
          `Streak: ${currentProgress.streak}`,
          `Study Minutes: ${currentProgress.study_minutes}`,
          `Quizzes Completed: ${currentProgress.quizzes_completed}`,
        ].join("\n"),
      );
      return;
    }
    const profile = authSession?.user;
    const students = await apiFetch("/managed-students");
    const student = students[0];
    if (!student) {
      openToast("No learner report is available yet.", "error");
      return;
    }
    const report = await apiFetch(`/students/${student.id}/report`);
    downloadTextReport(report.filename, report.report_text);
    if (profile) {
      saveAuthSession({ token: loadAuthSession()?.token, expires_at: loadAuthSession()?.expires_at, user: profile });
    }
  }

  function resetGuestStats() {
    if (mode !== "guest") return;
    localStorage.removeItem("prepbro_guest_stats");
    setSelfGoals([]);
    setProgress(null);
    setShowResetConfirm(false);
    window.location.reload();
  }

  async function resetCurrentStats() {
    if (mode === "guest") {
      resetGuestStats();
      return;
    }
    try {
      const clearedProgress = await apiFetch("/progress", withJsonBody("PUT", {
        points: 0,
        streak: 0,
        study_minutes: 0,
        quizzes_completed: 0,
        daily_points: {},
        daily_minutes: {},
        badges: [],
      }));
      setProgress(clearedProgress);
      setShowResetConfirm(false);
      openToast("Dashboard stats reset.", "success");
    } catch (error) {
      openToast(error.message || "Could not reset stats.", "error");
    }
  }

  return (
    <div className="dashboard-page">
      <div className="page-header dashboard-page-header">
        <div>
          <h2 className="card-title">Learning Dashboard</h2>
          <p className="card-subtitle">
            {mode === "guest"
              ? "Track your learning progress, badges, and recent activity."
              : "Track your learning progress, badges, assignments, and recent activity."}
          </p>
        </div>
        <button className="btn-primary dashboard-report-btn" type="button" onClick={downloadCurrentUserReport}>Download Report</button>
      </div>

      <div className="stats-grid dashboard-main-stats">
        <RefinedStatCard value={currentProgress.points || 0} label="Points" icon="⭐" accentClass="stat-points" />
        <RefinedStatCard value={currentProgress.streak || 0} label="Streak" icon="🔥" accentClass="stat-streak" />
        <RefinedStatCard value={totalStudyTime} label="Minutes" icon="⏰" accentClass="stat-time" />
        <RefinedStatCard value={currentProgress.quizzes_completed || 0} label="Quiz" icon="🎯" accentClass="stat-accuracy" />
      </div>

      <RefinedAssignmentsSection
        assignments={assignments}
        selfGoals={selfGoals}
        mode={mode}
        assignmentRefs={assignmentRefs}
        onToggleStatus={updateAssignmentStatus}
        onOpenGoalEditor={openGoalEditor}
        onDeleteGoal={deleteGoal}
      />

      <section className="card dashboard-estimated-line">
        <p>{`Estimated accuracy: ${accuracy !== "—" ? accuracy : "No quiz data yet"}`}</p>
      </section>
      <RefinedPointsChart pointChart={pointChart} dayKeys={dayKeys} maxPts={maxPts} />
      <RefinedStudyTimeChart minuteChart={minuteChart} maxMins={maxMins} />
      <RefinedSubjectBreakdown subjectData={subjectData} />

      <RefinedDashboardBadges
        achievedBadges={badgeSummary.achieved}
        lockedBadges={badgeSummary.locked}
        metrics={metrics}
        onBadgeClick={handleBadgeClick}
      />

      <section className="dashboard-reset-section">
        <button className="btn-ghost" type="button" onClick={() => setShowResetConfirm(true)}>Reset Stats</button>
      </section>

      {showResetConfirm ? (
        <DeleteConfirmModal
          title="Reset Stats"
          copy="Are you sure you want to reset your dashboard stats?"
          confirmLabel="Reset Stats"
          onConfirm={resetCurrentStats}
          onCancel={() => setShowResetConfirm(false)}
        />
      ) : null}

      {goalEditor !== null ? (
        <div className="badge-preview-overlay" role="presentation" onClick={() => setGoalEditor(null)}>
          <div className="badge-preview-card goal-editor-dialog" role="dialog" aria-modal="true" aria-label="Goal editor" onClick={(event) => event.stopPropagation()}>
            <div className="goal-editor-form">
              <h3>{goalEditor?.id ? "Edit Goal" : "Add Self Goal"}</h3>
              <div className="goal-editor-top-row">
                <label className="user-account-field">
                  <span>Title</span>
                  <input value={goalForm.title} onChange={(event) => setGoalForm((current) => ({ ...current, title: event.target.value }))} />
                </label>
                <label className="user-account-field">
                  <span>Due Date</span>
                  <input type="date" value={goalForm.due_date} onChange={(event) => setGoalForm((current) => ({ ...current, due_date: event.target.value }))} />
                </label>
              </div>
              <label className="user-account-field account-settings-field-wide">
                <span>Description</span>
                <textarea value={goalForm.description} onChange={(event) => setGoalForm((current) => ({ ...current, description: event.target.value }))} />
              </label>
              <div className="goal-editor-bottom-row">
                <label className="user-account-field">
                  <span>Priority</span>
                  <input value={goalForm.priority} onChange={(event) => setGoalForm((current) => ({ ...current, priority: event.target.value }))} />
                </label>
              </div>
            </div>
            <div className="account-settings-actions goal-editor-actions">
              <button className="btn-primary" type="button" onClick={saveGoal}>Save</button>
              <button className="btn-ghost" type="button" onClick={() => { setGoalEditor(null); setGoalForm(EMPTY_GOAL_FORM); }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      <RefinedBadgePreviewModal
        badge={badgeModal?.badge}
        achieved={badgeModal?.achieved}
        metrics={badgeModal?.metrics}
        onClose={() => setBadgeModal(null)}
      />
      <AssignmentNoticeModal
        items={assignmentNoticeItems}
        onView={handleNoticeView}
        onLater={() => setAssignmentNoticeItems([])}
        onMarkSeen={markNoticesSeen}
      />
      <AssignmentReminderModal
        items={assignmentReminderItems}
        onView={(assignmentId) => {
          dismissRemindersForToday();
          const match = assignments.find((item) => item.id === assignmentId);
          if (match) handleViewAssignment(match);
        }}
        onDismiss={dismissRemindersForToday}
      />
    </div>
  );
}

function RefinedMentorLearnerCard({
  learner,
  expanded,
  onToggle,
  onDownloadReport,
  assignments,
  onBadgeClick,
}) {
  const metrics = buildMetrics(learner.progress || EMPTY_PROGRESS, "account", { user: { preferences_json: learner.metadata || {} } });
  metrics.updated_at = learner.progress?.updated_at || null;
  const badgeSummary = buildBadgeSummary(metrics);
  const dayKeys = getLast7DayKeys();
  const pointChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyPoints[key] || 0) }));
  const minuteChart = dayKeys.map((key) => ({ key, label: getDayLabel(key), value: Number(metrics.dailyMinutes[key] || 0) }));
  const subjectData = Object.entries(metrics.subjectMinutes || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 6);
  const totalStudyTime = formatMinutes(metrics.studyMinutes || 0);
  const accuracy = learner.progress?.quizzes_completed > 0
    ? `${Math.min(99, 70 + Math.floor(learner.progress.quizzes_completed * 1.2))}%`
    : "—";
  const learnerAssignments = assignments
    .map((assignment) => {
      const target = (assignment.targets || []).find((item) => String(item.student_id) === String(learner.id));
      return target ? {
        ...assignment,
        status: target.status === "assigned" ? "pending" : target.status,
        marks_obtained: target.marks_obtained,
        max_marks: target.max_marks,
        feedback: target.feedback,
      } : null;
    })
    .filter(Boolean);
  const headerLabel = `${learner.learner_name} - ${learner.class?.name || learner.class_level || "Class not set"}`;

  return (
    <article className="card managed-student-dashboard-card mentor-learner-card">
      <div
        className={`mentor-learner-row ${expanded ? "mentor-learner-row-sticky" : ""}`}
        onClick={() => onToggle(learner.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onToggle(learner.id);
        }}
        role="button"
        tabIndex={0}
      >
        <div className={`mentor-learner-main ${expanded ? "mentor-learner-main-expanded" : ""}`}>
          <strong>{expanded ? headerLabel : learner.learner_name}</strong>
          {!expanded ? <span>{learner.class?.name || learner.class_level || "Class not set"}</span> : null}
        </div>
        <div className="mentor-learner-actions">
          <button className="btn-primary dashboard-report-btn" type="button" onClick={(event) => { event.stopPropagation(); onDownloadReport(learner); }}>
            Download Report
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mentor-learner-expanded">
          <section className="card card-subsection mentor-learner-compact-details">
            <div className="mentor-learner-detail-grid managed-student-detail-grid">
              <div className="managed-student-summary-chip"><strong>Age</strong><span>{learner.learner_age || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Gender</strong><span>{learner.metadata?.gender || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Class</strong><span>{learner.class?.name || learner.class_level || "Class not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Student Email</strong><span>{learner.metadata?.student_email || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Parent/Guardian Email</strong><span>{learner.metadata?.parent_guardian_email || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Learning Goal</strong><span>{learner.metadata?.learning_goal || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Preferred Subjects</strong><span>{(learner.metadata?.preferred_subjects || []).join(", ") || "Not set"}</span></div>
              <div className="managed-student-summary-chip"><strong>Daily Target</strong><span>{learner.metadata?.daily_study_target_minutes ? `${learner.metadata.daily_study_target_minutes} minutes` : "Not set"}</span></div>
            </div>
          </section>

          <div className="stats-grid managed-student-stats">
            <RefinedStatCard value={learner.progress?.points || 0} label="Points" icon="⭐" accentClass="stat-accent-yellow" />
            <RefinedStatCard value={learner.progress?.streak || 0} label="Streak" icon="🔥" accentClass="stat-accent-red" />
            <RefinedStatCard value={formatMinutes(learner.progress?.study_minutes || 0)} label="Minutes" icon="⏰" accentClass="stat-accent-blue" />
            <RefinedStatCard value={learner.progress?.quizzes_completed || 0} label="Quiz" icon="🎯" accentClass="stat-accent-green" />
          </div>

          <section className="card card-subsection">
            <h3 className="card-subheading">Mentor Assignments</h3>
            {!learnerAssignments.length ? <p className="account-settings-meta">No mentor assignments yet.</p> : null}
            <div className="mentor-learner-assignment-list">
              {learnerAssignments.map((assignment) => (
                <article className="card assignment-card student-assignment-card" key={`mentor-assignment-${learner.id}-${assignment.id}`}>
                  <div className="student-assignment-head">
                    <strong>{assignment.title}</strong>
                    <span className={`assignment-status-pill ${assignment.status === "completed" ? "assignment-status-pill-completed" : "assignment-status-pill-pending"}`}>
                      {assignment.status === "completed" ? "Completed" : "Pending"}
                    </span>
                  </div>
                  <div className="student-assignment-body">
                    <div className="student-assignment-copy">
                      <p className="assignment-description">{assignment.description || "No description added yet."}</p>
                      <div className="assignment-meta-list">
                        <span>{assignment.due_date ? formatDueDateText(assignment.due_date) : "No due date"}</span>
                        {assignment.max_marks ? <span>{`Marks: ${assignment.marks_obtained ?? 0} / ${assignment.max_marks}`}</span> : null}
                        {assignment.feedback ? <span>{`Feedback: ${assignment.feedback}`}</span> : null}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="card dashboard-estimated-line">
            <p>{`Estimated accuracy: ${accuracy !== "—" ? accuracy : "No quiz data yet"}`}</p>
          </section>
          <RefinedPointsChart pointChart={pointChart} dayKeys={dayKeys} maxPts={Math.max(...pointChart.map((item) => item.value), 1)} />
          <RefinedStudyTimeChart minuteChart={minuteChart} maxMins={Math.max(...minuteChart.map((item) => item.value), 1)} />
          <RefinedDashboardBadges
            achievedBadges={badgeSummary.achieved}
            lockedBadges={[]}
            metrics={metrics}
            onBadgeClick={onBadgeClick}
            showLocked={false}
          />
        </div>
      ) : null}
    </article>
  );
}

export default function Dashboard({ active, authSession, mode, mentorSection = "dashboard" }) {
  const session = authSession || loadAuthSession();
  const currentMode = mode || (session?.token ? "account" : "guest");

  useEffect(() => {
    if (!active) return undefined;
    const onAuthChanged = () => {
      const next = loadAuthSession();
      if (!next?.token && window.location.hash.startsWith("#assignment-")) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    };
    window.addEventListener("prepbro:auth-changed", onAuthChanged);
    return () => window.removeEventListener("prepbro:auth-changed", onAuthChanged);
  }, [active]);

  if (!active) return null;

  if (currentMode === "account" && session?.user?.role === "teacher") {
    return <MentorDashboard authSession={session} mentorSection={mentorSection} />;
  }

  return <RefinedStudentDashboard authSession={session} mode={currentMode} />;
}

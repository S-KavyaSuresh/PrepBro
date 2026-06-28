from __future__ import annotations

import base64
import json
import os
import re
import secrets
import sqlite3
import traceback
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

import pydantic
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.auth import (
    build_current_user_dependency,
    create_access_token,
    hash_password,
    verify_password,
)
from app.config import get_settings
from app.db import Database, utc_now
from app.emailer import send_verification_email
from app.services.ai import (
    OpenRouterClient,
    extract_image_data_url_from_chat,
    safe_json_loads,
)
from app.services.extract import extract_text_from_upload, pdf_to_base64_images

load_dotenv()

settings = get_settings()
database = Database(settings)
current_user_dependency = build_current_user_dependency(database, settings)

app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ai = OpenRouterClient.from_env()


@app.on_event("startup")
def startup() -> None:
    if settings.app_env.lower() == "production" and not settings.jwt_secret:
        raise RuntimeError("JWT_SECRET must be configured in production.")
    database.initialize()


@app.get("/")
def read_root() -> Dict[str, Any]:
    return {"message": "Welcome to PrepBro API", "health": "/health"}


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "app": settings.app_name,
        "env": settings.app_env,
    }


ROLE_VALUES = {"student", "teacher"}
CHILD_AGE_THRESHOLD = 13


QUIZ_STOPWORDS = {
    "about", "after", "again", "against", "because", "before", "being", "below",
    "between", "could", "every", "first", "found", "from", "have", "into", "might",
    "other", "should", "their", "there", "these", "those", "through", "under",
    "using", "where", "which", "while", "would", "your", "study", "student", "text",
}


def _split_quiz_sentences(text: str) -> List[str]:
    sentences = [
        re.sub(r"\s+", " ", chunk).strip(" -\n\t")
        for chunk in re.split(r"(?<=[.!?])\s+|\n+", text)
    ]
    return [sentence for sentence in sentences if len(sentence) >= 24]


def _candidate_quiz_words(sentence: str) -> List[str]:
    seen: set[str] = set()
    words = re.findall(r"[A-Za-z][A-Za-z'-]{3,}", sentence)
    ranked: List[str] = []
    for word in words:
        lowered = word.lower()
        if lowered in QUIZ_STOPWORDS or lowered in seen:
            continue
        seen.add(lowered)
        ranked.append(word)
    return ranked


def _build_local_quiz(text: str, count: int) -> Dict[str, Any]:
    sentences = _split_quiz_sentences(text)
    if not sentences:
        sentences = [re.sub(r"\s+", " ", text).strip()]
    pool = sentences[:]
    questions: List[Dict[str, Any]] = []
    used_prompts: set[str] = set()

    for sentence_index, sentence in enumerate(pool):
        keywords = _candidate_quiz_words(sentence)
        if not keywords:
            continue
        correct_word = keywords[0]
        prompt = sentence.replace(correct_word, "____", 1)
        if prompt in used_prompts:
            continue
        distractors: List[str] = []
        for other_sentence in pool:
            if other_sentence == sentence:
                continue
            for other_word in _candidate_quiz_words(other_sentence):
                if other_word.lower() != correct_word.lower() and other_word not in distractors:
                    distractors.append(other_word)
                if len(distractors) >= 3:
                    break
            if len(distractors) >= 3:
                break
        while len(distractors) < 3:
            distractors.append(f"Option {len(distractors) + 2}")
        choices = [correct_word, *distractors[:3]]
        rotation = sentence_index % len(choices)
        rotated_choices = choices[rotation:] + choices[:rotation]
        answer_index = rotated_choices.index(correct_word)
        questions.append({
            "question": f"Fill in the missing word: {prompt}",
            "choices": rotated_choices,
            "answerIndex": answer_index,
            "explanation": f"The study text states: {sentence}",
        })
        used_prompts.add(prompt)
        if len(questions) >= count:
            break

    if len(questions) < count:
        for sentence_index, sentence in enumerate(pool):
            if len(questions) >= count:
                break
            prompt = f"What does the text say about this idea? \"{sentence[:48]}{'...' if len(sentence) > 48 else ''}\""
            if prompt in used_prompts:
                continue
            fallback_choices = [sentence]
            for other_sentence in pool:
                if other_sentence == sentence:
                    continue
                fallback_choices.append(other_sentence)
                if len(fallback_choices) == 4:
                    break
            while len(fallback_choices) < 4:
                fallback_choices.append("This detail is not mentioned in the text.")
            rotation = sentence_index % len(fallback_choices)
            rotated_choices = fallback_choices[rotation:] + fallback_choices[:rotation]
            questions.append({
                "question": prompt,
                "choices": rotated_choices,
                "answerIndex": rotated_choices.index(sentence),
                "explanation": f"The text directly mentions: {sentence}",
            })
            used_prompts.add(prompt)

    return {"questions": questions[:count]}


class SignupRequest(pydantic.BaseModel):
    role: Literal["student", "teacher"] = "student"
    email: Optional[pydantic.EmailStr] = None
    password: str
    display_name: str = ""
    learner_age: Optional[int] = None
    learning_goal: str = ""
    preferred_subjects: List[str] = pydantic.Field(default_factory=list)
    daily_study_target_minutes: Optional[int] = None
    parent_guardian_email: Optional[pydantic.EmailStr] = None
    teacher_email: Optional[pydantic.EmailStr] = None
    school_grade: str = ""
    school_organization: str = ""
    subject_department: str = ""
    preferences_json: Dict[str, Any] = pydantic.Field(default_factory=dict)


class LoginRequest(pydantic.BaseModel):
    email: str
    password: str


class ProfileUpdateRequest(pydantic.BaseModel):
    display_name: str = ""
    age: Optional[int] = None
    learning_goal: str = ""
    preferences_json: Dict[str, Any] = pydantic.Field(default_factory=dict)


class ProgressUpdateRequest(pydantic.BaseModel):
    points: int = 0
    streak: int = 0
    study_minutes: int = 0
    quizzes_completed: int = 0
    daily_points: Dict[str, int] = pydantic.Field(default_factory=dict)
    daily_minutes: Dict[str, int] = pydantic.Field(default_factory=dict)
    badges: List[str] = pydantic.Field(default_factory=list)


class VerificationRequest(pydantic.BaseModel):
    token: str


class SignupEmailVerificationRequest(pydantic.BaseModel):
    email: pydantic.EmailStr
    draft: Dict[str, Any] = pydantic.Field(default_factory=dict)


class StudentCreateRequest(pydantic.BaseModel):
    learner_name: str
    learner_age: Optional[int] = None
    student_email: Optional[pydantic.EmailStr] = None
    gender: str = ""
    class_level: str = ""
    learning_goal: str = ""
    preferred_subjects: List[str] = pydantic.Field(default_factory=list)
    daily_study_target_minutes: Optional[int] = None
    parent_guardian_email: Optional[pydantic.EmailStr] = None
    teacher_email: Optional[pydantic.EmailStr] = None
    school_grade: str = ""


class StudentUpdateRequest(pydantic.BaseModel):
    learner_name: Optional[str] = None
    learner_age: Optional[int] = None
    student_email: Optional[pydantic.EmailStr] = None
    gender: Optional[str] = None
    class_level: Optional[str] = None
    learning_goal: Optional[str] = None
    preferred_subjects: Optional[List[str]] = None
    daily_study_target_minutes: Optional[int] = None
    parent_guardian_email: Optional[pydantic.EmailStr] = None
    teacher_email: Optional[pydantic.EmailStr] = None


class ClassCreateRequest(pydantic.BaseModel):
    name: str
    grade_level: str = ""
    subject: str = ""
    description: str = ""
    schedule: str = ""
    academic_year: str = ""


class ClassUpdateRequest(pydantic.BaseModel):
    name: Optional[str] = None
    grade_level: Optional[str] = None
    subject: Optional[str] = None
    description: Optional[str] = None
    schedule: Optional[str] = None
    academic_year: Optional[str] = None


class ClassAssignmentRequest(pydantic.BaseModel):
    class_id: Optional[int] = None


class AssignmentCreateRequest(pydantic.BaseModel):
    title: str
    description: str = ""
    due_date: Optional[str] = None
    student_ids: List[int] = pydantic.Field(default_factory=list)
    assign_to_all: bool = False
    class_id: Optional[int] = None
    priority: str = ""


class AssignmentUpdateRequest(pydantic.BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    student_ids: Optional[List[int]] = None
    assign_to_all: bool = False
    class_id: Optional[int] = None
    priority: Optional[str] = None


class AssignmentStatusUpdateRequest(pydantic.BaseModel):
    status: Literal["pending", "completed"]


class StudentAssignmentSeenRequest(pydantic.BaseModel):
    seen: bool = True


class AssignmentGradeUpdateRequest(pydantic.BaseModel):
    marks_obtained: Optional[float] = None
    max_marks: Optional[float] = None
    feedback: str = ""


class SelfGoalCreateRequest(pydantic.BaseModel):
    title: str
    description: str = ""
    due_date: Optional[str] = None
    priority: str = ""


class SelfGoalUpdateRequest(pydantic.BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    priority: Optional[str] = None


def normalize_preferences(
    *,
    learning_goal: str = "",
    preferred_subjects: Optional[List[str]] = None,
    daily_study_target_minutes: Optional[int] = None,
    parent_guardian_email: Optional[str] = None,
    teacher_email: Optional[str] = None,
    school_grade: str = "",
    school_organization: str = "",
    subject_department: str = "",
    student_email: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    preferences = dict(extra or {})
    preferences["preferred_subjects"] = [subject.strip() for subject in (preferred_subjects or []) if subject.strip()]
    preferences["daily_study_target_minutes"] = daily_study_target_minutes
    preferences["parent_guardian_email"] = parent_guardian_email or preferences.get("parent_guardian_email")
    preferences["teacher_email"] = teacher_email or preferences.get("teacher_email")
    preferences["school_grade"] = school_grade or preferences.get("school_grade", "")
    preferences["school_organization"] = school_organization or preferences.get("school_organization", "")
    preferences["subject_department"] = subject_department or preferences.get("subject_department", "")
    preferences["student_email"] = student_email or preferences.get("student_email")
    if learning_goal:
        preferences["learning_goal"] = learning_goal.strip()
    return preferences


def compute_badges(points: int, streak: int, study_minutes: int, quizzes_completed: int) -> List[str]:
    badges: List[str] = []
    if points >= 10:
        badges.append("First Steps")
    if study_minutes >= 60:
        badges.append("One Hour Hero")
    if quizzes_completed >= 5:
        badges.append("Quiz Explorer")
    if streak >= 3:
        badges.append("Consistency Star")
    if points >= 200:
        badges.append("PrepBro Pro")
    return badges


def empty_progress(student_id: Optional[int] = None) -> Dict[str, Any]:
    return {
        "student_id": student_id,
        "points": 0,
        "streak": 0,
        "study_minutes": 0,
        "quizzes_completed": 0,
        "daily_points": {},
        "daily_minutes": {},
        "badges": [],
        "updated_at": utc_now(),
    }


def serialize_user(connection, user_id: int) -> Dict[str, Any]:
    database.ensure_profile_record(connection, user_id=user_id)
    row = connection.execute(
        """
        SELECT
            u.id,
            u.email,
            u.role,
            u.is_verified,
            u.created_at,
            p.user_id,
            p.display_name,
            p.age,
            p.learning_goal,
            p.preferences_json
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = ?
        """,
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found.")
    user = database.row_to_profile(row)
    preferences = user.get("preferences_json") or {}
    parent_guardian_email = str(preferences.get("parent_guardian_email") or "").strip().lower()
    teacher_email = str(preferences.get("teacher_email") or "").strip().lower()
    teacher_row = None
    if teacher_email:
        teacher_row = connection.execute(
            "SELECT id, email, role, is_verified FROM users WHERE email = ?",
            (teacher_email,),
        ).fetchone()
    user["linked_email_statuses"] = {
        "parent_guardian_email": {
            "email": parent_guardian_email or None,
            "verified": None,
        },
        "teacher_email": {
            "email": teacher_email or None,
            "exists": bool(teacher_row),
            "verified": bool(teacher_row["is_verified"]) if teacher_row else False,
            "role": teacher_row["role"] if teacher_row else None,
        },
    }
    return user


def get_teacher_user_by_email(connection, email: str | None) -> Optional[sqlite3.Row]:
    normalized = str(email or "").strip().lower()
    if not normalized:
        return None
    return connection.execute(
        "SELECT id, email, role, is_verified FROM users WHERE email = ?",
        (normalized,),
    ).fetchone()


def get_primary_student_id(connection, current_user: Dict[str, Any]) -> Optional[int]:
    row = connection.execute(
        """
        SELECT s.id
        FROM students s
        INNER JOIN student_links sl ON sl.student_id = s.id
        WHERE sl.user_id = ?
        ORDER BY
            CASE sl.relationship_type
                WHEN 'self' THEN 0
                WHEN 'parent' THEN 1
                WHEN 'teacher' THEN 2
                ELSE 3
            END,
            s.id ASC
        LIMIT 1
        """,
        (current_user["id"],),
    ).fetchone()
    return row["id"] if row else None


def require_mentor(current_user: Dict[str, Any], action: str) -> None:
    if current_user["role"] != "teacher":
        raise HTTPException(status_code=403, detail=f"Only mentor accounts can {action}.")


def require_student(current_user: Dict[str, Any], action: str) -> None:
    if current_user["role"] != "student":
        raise HTTPException(status_code=403, detail=f"Only student accounts can {action}.")


def serialize_class_row(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "grade_level": row["grade_level"] or "",
        "subject": row["subject"] or "",
        "description": row["description"] or "",
        "schedule": row["schedule"] or "",
        "academic_year": row["academic_year"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_classes_for_mentor(connection, mentor_user_id: int) -> List[Dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            c.id,
            c.name,
            c.grade_level,
            c.subject,
            c.description,
            c.schedule,
            c.academic_year,
            c.created_at,
            c.updated_at,
            COUNT(scl.student_id) AS learner_count
        FROM classes c
        LEFT JOIN student_class_links scl ON scl.class_id = c.id
        WHERE c.mentor_user_id = ?
        GROUP BY c.id
        ORDER BY c.created_at ASC, c.id ASC
        """,
        (mentor_user_id,),
    ).fetchall()
    classes = []
    for row in rows:
        item = serialize_class_row(row)
        item["learner_count"] = int(row["learner_count"] or 0)
        classes.append(item)
    return classes


def get_authorized_class(connection, mentor_user_id: int, class_id: int) -> Dict[str, Any]:
    row = connection.execute(
        """
        SELECT id, mentor_user_id, name, grade_level, subject, description, schedule, academic_year, created_at, updated_at
        FROM classes
        WHERE id = ?
        """,
        (class_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Class not found.")
    if row["mentor_user_id"] != mentor_user_id:
        raise HTTPException(status_code=403, detail="You can only manage classes linked to your mentor account.")
    return serialize_class_row(row)


def get_managed_student_for_mentor(connection, mentor_user_id: int, student_id: int) -> Dict[str, Any]:
    existing = connection.execute(
        "SELECT id FROM students WHERE id = ?",
        (student_id,),
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Learner not found.")
    linked = connection.execute(
        """
        SELECT 1
        FROM student_links
        WHERE student_id = ? AND user_id = ?
        LIMIT 1
        """,
        (student_id, mentor_user_id),
    ).fetchone()
    if not linked:
        raise HTTPException(status_code=403, detail="You can only manage learners linked to your mentor account.")
    return get_authorized_student(connection, {"id": mentor_user_id}, student_id)


def set_student_class_assignment(
    connection,
    *,
    mentor_user_id: int,
    student_id: int,
    class_id: Optional[int],
) -> Dict[str, Any]:
    get_managed_student_for_mentor(connection, mentor_user_id, student_id)
    class_name = ""
    if class_id is not None:
        class_info = get_authorized_class(connection, mentor_user_id, class_id)
        class_name = class_info["name"]
        connection.execute(
            """
            INSERT INTO student_class_links (class_id, student_id, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(student_id) DO UPDATE SET class_id = excluded.class_id
            """,
            (class_id, student_id, utc_now()),
        )
    else:
        connection.execute("DELETE FROM student_class_links WHERE student_id = ?", (student_id,))
    connection.execute(
        "UPDATE students SET class_level = ? WHERE id = ?",
        (class_name, student_id),
    )
    return get_authorized_student(connection, {"id": mentor_user_id}, student_id) | {
        "progress": serialize_progress(connection, student_id),
    }


def get_managed_student_ids(connection, mentor_user_id: int) -> set[int]:
    return {
        row["id"]
        for row in list_students_for_user(connection, mentor_user_id)
    }


def resolve_assignment_target_ids(
    connection,
    *,
    mentor_user_id: int,
    assign_to_all: bool,
    class_id: Optional[int],
    student_ids: List[int],
) -> set[int]:
    managed_ids = get_managed_student_ids(connection, mentor_user_id)
    if assign_to_all:
        return managed_ids
    if class_id is not None:
        get_authorized_class(connection, mentor_user_id, class_id)
        target_ids = {
            row["student_id"]
            for row in connection.execute(
                "SELECT student_id FROM student_class_links WHERE class_id = ?",
                (class_id,),
            ).fetchall()
        }
        if not target_ids:
            return set()
        if not target_ids.issubset(managed_ids):
            raise HTTPException(status_code=403, detail="You can only assign work to learners linked to your mentor account.")
        return target_ids
    target_ids = set(student_ids)
    if not target_ids:
        return set()
    if not target_ids.issubset(managed_ids):
        raise HTTPException(status_code=403, detail="You can only assign work to learners linked to your mentor account.")
    for student_id in target_ids:
        get_managed_student_for_mentor(connection, mentor_user_id, student_id)
    return target_ids


def get_authorized_assignment_for_mentor(connection, mentor_user_id: int, assignment_id: int) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT id, teacher_user_id, owner_user_id, assignment_type, title, description, due_date, class_id, priority, created_at, updated_at
        FROM assignments
        WHERE id = ?
        """,
        (assignment_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    if row["teacher_user_id"] != mentor_user_id:
        raise HTTPException(status_code=403, detail="You can only manage assignments created by your mentor account.")
    return row


def get_authorized_self_goal(connection, owner_user_id: int, assignment_id: int) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT id, teacher_user_id, owner_user_id, assignment_type, title, description, due_date, class_id, priority, created_at, updated_at
        FROM assignments
        WHERE id = ?
        """,
        (assignment_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Goal not found.")
    if row["assignment_type"] != "self_assigned" or row["owner_user_id"] != owner_user_id:
        raise HTTPException(status_code=403, detail="You can only manage your own goals.")
    return row


def list_assignments_for_mentor(connection, mentor_user_id: int) -> List[Dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT a.id, a.teacher_user_id, a.owner_user_id, a.assignment_type, a.title, a.description, a.due_date, a.class_id, a.priority, a.created_at, a.updated_at, c.name AS class_name
        FROM assignments a
        LEFT JOIN classes c ON c.id = a.class_id
        WHERE a.teacher_user_id = ? AND a.assignment_type = 'mentor_assigned'
        ORDER BY a.created_at DESC, a.id DESC
        """,
        (mentor_user_id,),
    ).fetchall()
    assignments: List[Dict[str, Any]] = []
    for row in rows:
        targets = connection.execute(
                """
                SELECT
                    at.student_id,
                    at.status,
                    at.created_at,
                    at.seen_at,
                    at.completed_at,
                    at.marks_obtained,
                    at.max_marks,
                    at.feedback,
                    at.graded_at,
                    s.learner_name
                FROM assignment_targets at
                INNER JOIN students s ON s.id = at.student_id
                WHERE at.assignment_id = ?
                ORDER BY s.learner_name ASC
                """,
            (row["id"],),
        ).fetchall()
        assignments.append(
            {
                "id": row["id"],
                "title": row["title"],
                    "description": row["description"],
                    "due_date": row["due_date"],
                    "class_id": row["class_id"],
                    "class_name": row["class_name"],
                    "priority": row["priority"] or "",
                    "assignment_type": row["assignment_type"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "targets": [
                        {
                            "student_id": target["student_id"],
                            "learner_name": target["learner_name"],
                            "status": "pending" if target["status"] == "assigned" else target["status"],
                            "assigned_at": target["created_at"],
                            "seen_at": target["seen_at"],
                            "completed_at": target["completed_at"],
                            "marks_obtained": target["marks_obtained"],
                            "max_marks": target["max_marks"],
                            "feedback": target["feedback"] or "",
                            "graded_at": target["graded_at"],
                        }
                        for target in targets
                    ],
                    "assigned_count": len(targets),
                    "completed_count": len([target for target in targets if target["status"] == "completed"]),
                    "pending_count": len([target for target in targets if target["status"] != "completed"]),
                }
        )
    return assignments


def list_assignments_for_student(connection, student_id: int) -> List[Dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            a.id,
            a.assignment_type,
            a.title,
            a.description,
            a.due_date,
            a.priority,
            a.created_at,
            a.updated_at,
            a.class_id,
            c.name AS class_name,
            at.status,
            at.created_at AS assigned_at,
            at.seen_at,
            at.completed_at,
            at.marks_obtained,
            at.max_marks,
            at.feedback,
            at.graded_at,
            COALESCE(p.display_name, u.email) AS mentor_name
        FROM assignment_targets at
        INNER JOIN assignments a ON a.id = at.assignment_id
        INNER JOIN users u ON u.id = a.teacher_user_id
        LEFT JOIN profiles p ON p.user_id = u.id
        LEFT JOIN classes c ON c.id = a.class_id
        WHERE at.student_id = ? AND a.assignment_type = 'mentor_assigned'
        ORDER BY COALESCE(a.due_date, a.created_at) ASC, a.id DESC
        """,
        (student_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "due_date": row["due_date"],
            "priority": row["priority"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "class_id": row["class_id"],
            "class_name": row["class_name"],
            "mentor_name": row["mentor_name"],
            "assignment_type": row["assignment_type"],
            "status": "pending" if row["status"] == "assigned" else row["status"],
            "assigned_at": row["assigned_at"],
            "seen_at": row["seen_at"],
            "completed_at": row["completed_at"],
            "marks_obtained": row["marks_obtained"],
            "max_marks": row["max_marks"],
            "feedback": row["feedback"] or "",
            "graded_at": row["graded_at"],
        }
        for row in rows
    ]


def get_assignment_for_mentor(connection, mentor_user_id: int, assignment_id: int) -> Dict[str, Any]:
    assignment = next((item for item in list_assignments_for_mentor(connection, mentor_user_id) if item["id"] == assignment_id), None)
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    return assignment


def list_self_goals_for_student(connection, current_user: Dict[str, Any], student_id: int) -> List[Dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            a.id,
            a.title,
            a.description,
            a.due_date,
            a.priority,
            a.created_at,
            a.updated_at,
            at.status,
            at.created_at AS assigned_at,
            at.completed_at
        FROM assignments a
        INNER JOIN assignment_targets at ON at.assignment_id = a.id
        WHERE a.assignment_type = 'self_assigned' AND a.owner_user_id = ? AND at.student_id = ?
        ORDER BY COALESCE(a.due_date, a.created_at) ASC, a.id DESC
        """,
        (current_user["id"], student_id),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "due_date": row["due_date"],
            "priority": row["priority"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "status": "pending" if row["status"] == "assigned" else row["status"],
            "assigned_at": row["assigned_at"],
            "completed_at": row["completed_at"],
            "assignment_type": "self_assigned",
            "seen_at": row["assigned_at"],
        }
        for row in rows
    ]


def serialize_progress(connection, student_id: int) -> Dict[str, Any]:
    row = connection.execute(
        """
        SELECT
            student_id,
            points,
            streak,
            study_minutes,
            quizzes_completed,
            daily_points_json,
            daily_minutes_json,
            badges_json,
            updated_at
        FROM progress
        WHERE student_id = ?
        """,
        (student_id,),
    ).fetchone()
    if not row:
        return empty_progress(student_id)
    progress = database.row_to_progress(row)
    progress["badges"] = progress["badges"] or compute_badges(
        progress["points"],
        progress["streak"],
        progress["study_minutes"],
        progress["quizzes_completed"],
    )
    return progress


def serialize_primary_progress(connection, current_user: Dict[str, Any]) -> Dict[str, Any]:
    primary_student_id = get_primary_student_id(connection, current_user)
    if primary_student_id is None:
        return empty_progress()
    return serialize_progress(connection, primary_student_id)


def list_students_for_user(connection, user_id: int) -> List[Dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            s.id,
            s.learner_name,
            s.learner_age,
            s.owner_user_id,
            s.class_level,
            s.metadata_json,
            s.created_at,
            sl.relationship_type,
            u.email AS owner_email,
            p.learning_goal AS owner_learning_goal,
            p.preferences_json AS owner_preferences_json,
            c.id AS class_id,
            c.name AS class_name,
            c.grade_level AS class_grade_level,
            c.subject AS class_subject,
            c.description AS class_description,
            c.schedule AS class_schedule,
            c.academic_year AS class_academic_year
        FROM students s
        INNER JOIN student_links sl ON sl.student_id = s.id
        LEFT JOIN users u ON u.id = s.owner_user_id
        LEFT JOIN profiles p ON p.user_id = s.owner_user_id
        LEFT JOIN student_class_links scl ON scl.student_id = s.id
        LEFT JOIN classes c ON c.id = scl.class_id
        WHERE sl.user_id = ?
        ORDER BY s.created_at ASC, s.id ASC
        """,
        (user_id,),
    ).fetchall()
    students = []
    for row in rows:
        progress = serialize_progress(connection, row["id"])
        metadata = json.loads(row["metadata_json"] or "{}")
        owner_preferences = json.loads(row["owner_preferences_json"] or "{}")
        merged_metadata = {**owner_preferences, **metadata}
        if row["owner_learning_goal"] and not merged_metadata.get("learning_goal"):
            merged_metadata["learning_goal"] = row["owner_learning_goal"]
        if row["owner_email"] and not merged_metadata.get("student_email"):
            merged_metadata["student_email"] = row["owner_email"]
        students.append(
            {
                "id": row["id"],
                "learner_name": row["learner_name"],
                "learner_age": row["learner_age"],
                "owner_user_id": row["owner_user_id"],
                "relationship_type": row["relationship_type"],
                "class_level": row["class_name"] or row["class_level"] or "",
                "class": (
                    {
                        "id": row["class_id"],
                        "name": row["class_name"] or "",
                        "grade_level": row["class_grade_level"] or "",
                        "subject": row["class_subject"] or "",
                        "description": row["class_description"] or "",
                        "schedule": row["class_schedule"] or "",
                        "academic_year": row["class_academic_year"] or "",
                    }
                    if row["class_id"] is not None
                    else None
                ),
                "metadata": merged_metadata,
                "created_at": row["created_at"],
                "progress": progress,
            }
        )
    return students


def get_authorized_student(connection, current_user: Dict[str, Any], student_id: int) -> Dict[str, Any]:
    row = connection.execute(
        """
        SELECT
            s.id,
            s.learner_name,
            s.learner_age,
            s.owner_user_id,
            s.class_level,
            s.metadata_json,
            s.created_at,
            sl.relationship_type,
            c.id AS class_id,
            c.name AS class_name,
            c.grade_level AS class_grade_level,
            c.subject AS class_subject,
            c.description AS class_description,
            c.schedule AS class_schedule,
            c.academic_year AS class_academic_year
        FROM students s
        INNER JOIN student_links sl ON sl.student_id = s.id
        LEFT JOIN student_class_links scl ON scl.student_id = s.id
        LEFT JOIN classes c ON c.id = scl.class_id
        WHERE s.id = ? AND sl.user_id = ?
        LIMIT 1
        """,
        (student_id, current_user["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Student not found.")
    return {
        "id": row["id"],
        "learner_name": row["learner_name"],
        "learner_age": row["learner_age"],
        "owner_user_id": row["owner_user_id"],
        "class_level": row["class_name"] or row["class_level"] or "",
        "class": (
            {
                "id": row["class_id"],
                "name": row["class_name"] or "",
                "grade_level": row["class_grade_level"] or "",
                "subject": row["class_subject"] or "",
                "description": row["class_description"] or "",
                "schedule": row["class_schedule"] or "",
                "academic_year": row["class_academic_year"] or "",
            }
            if row["class_id"] is not None
            else None
        ),
        "metadata": json.loads(row["metadata_json"] or "{}"),
        "created_at": row["created_at"],
        "relationship_type": row["relationship_type"],
    }


def upsert_progress(connection, student_id: int, payload: ProgressUpdateRequest) -> Dict[str, Any]:
    badges = payload.badges or compute_badges(
        payload.points,
        payload.streak,
        payload.study_minutes,
        payload.quizzes_completed,
    )
    connection.execute(
        """
        INSERT INTO progress (
            student_id,
            points,
            streak,
            study_minutes,
            quizzes_completed,
            daily_points_json,
            daily_minutes_json,
            badges_json,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET
            points = excluded.points,
            streak = excluded.streak,
            study_minutes = excluded.study_minutes,
            quizzes_completed = excluded.quizzes_completed,
            daily_points_json = excluded.daily_points_json,
            daily_minutes_json = excluded.daily_minutes_json,
            badges_json = excluded.badges_json,
            updated_at = excluded.updated_at
        """,
        (
            student_id,
            payload.points,
            payload.streak,
            payload.study_minutes,
            payload.quizzes_completed,
            json.dumps(payload.daily_points or {}),
            json.dumps(payload.daily_minutes or {}),
            json.dumps(badges),
            utc_now(),
        ),
    )
    return serialize_progress(connection, student_id)


def create_verification_token(connection, user_id: int) -> Dict[str, Any]:
    token = secrets.token_urlsafe(32)
    created_at = utc_now()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    connection.execute(
        """
        INSERT INTO verification_tokens (user_id, token, expires_at, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
        """,
        (user_id, token, expires_at, created_at),
    )
    return {"token": token, "created_at": created_at, "expires_at": expires_at}


def create_pending_signup_verification(connection, email: str) -> Dict[str, Any]:
    return create_pending_signup_verification_with_draft(connection, email, {})


def sanitize_signup_draft(raw_draft: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    draft = dict(raw_draft or {})
    allowed_keys = {
        "role",
        "display_name",
        "learner_age",
        "gender",
        "email",
        "parent_guardian_email",
        "mentor_email",
        "learning_goal",
        "preferred_subjects",
        "daily_study_target_minutes",
        "school_organization",
        "class_handled",
        "subject_department",
    }
    sanitized: Dict[str, Any] = {}
    for key in allowed_keys:
        value = draft.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            sanitized[key] = value
        else:
            sanitized[key] = str(value)
    return sanitized


def create_pending_signup_verification_with_draft(connection, email: str, draft: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    token = secrets.token_urlsafe(32)
    created_at = utc_now()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    draft_json = json.dumps(sanitize_signup_draft(draft))
    connection.execute("DELETE FROM pending_email_verifications WHERE email = ?", (email,))
    connection.execute(
        """
        INSERT INTO pending_email_verifications (email, token, draft_json, expires_at, verified_at, used_at, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?)
        """,
        (email, token, draft_json, expires_at, created_at),
    )
    return {"token": token, "created_at": created_at, "expires_at": expires_at}


def send_signup_email_verification_response(connection, email: str, draft: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    existing = connection.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")
    verification = create_pending_signup_verification_with_draft(connection, email, draft)
    result = send_verification_email(
        settings=settings,
        email=email,
        token=verification["token"],
        verify_url=f"{settings.frontend_url.rstrip('/')}/?verify={verification['token']}",
    )
    if settings.app_env.lower() == "production" and not result.get("sent"):
        result = {"sent": False, "reason": "SMTP is not configured for this deployment."}
    return {
        "ok": True,
        "email": email,
        "expires_at": verification["expires_at"],
        **result,
    }


def send_verification_response(connection, user_id: int, email: str) -> Dict[str, Any]:
    user = serialize_user(connection, user_id)
    if user["is_verified"]:
        return {
            "ok": True,
            "user_id": user_id,
            "sent": False,
            "already_verified": True,
            "reason": "This account is already verified.",
        }
    verification = create_verification_token(connection, user_id)
    result = send_verification_email(
        settings=settings,
        email=email,
        token=verification["token"],
        verify_url=f"{settings.frontend_url.rstrip('/')}/?verify={verification['token']}",
    )
    if settings.app_env.lower() == "production" and not result.get("sent"):
        result = {"sent": False, "reason": "SMTP is not configured for this deployment."}
    return {
        "ok": True,
        "user_id": user_id,
        "user": user,
        "expires_at": verification["expires_at"],
        **result,
    }


def verify_email_token(connection, token: str) -> Dict[str, Any]:
    pending = connection.execute(
        """
        SELECT id, email, token, draft_json, expires_at, verified_at, used_at
        FROM pending_email_verifications
        WHERE token = ?
        """,
        (token,),
    ).fetchone()
    if pending:
        if pending["used_at"]:
            raise HTTPException(status_code=400, detail="Verification token already used.")
        expires_at = datetime.fromisoformat(pending["expires_at"])
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Verification token expired.")
        if not pending["verified_at"]:
            connection.execute("UPDATE pending_email_verifications SET verified_at = ? WHERE id = ?", (utc_now(), pending["id"]))
        return {
            "ok": True,
            "pending_signup": True,
            "email": pending["email"],
            "draft": json.loads(pending["draft_json"] or "{}"),
        }

    row = connection.execute(
        """
        SELECT id, user_id, token, expires_at, used_at
        FROM verification_tokens
        WHERE token = ?
        """,
        (token,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="Invalid verification token.")
    if row["used_at"]:
        raise HTTPException(status_code=400, detail="Verification token already used.")
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Verification token expired.")
    connection.execute("UPDATE verification_tokens SET used_at = ? WHERE id = ?", (utc_now(), row["id"]))
    connection.execute("UPDATE users SET is_verified = 1 WHERE id = ?", (row["user_id"],))
    return {"ok": True, "user": serialize_user(connection, row["user_id"])}


def require_verified_signup_email(connection, email: str) -> None:
    row = connection.execute(
        """
        SELECT id
        FROM pending_email_verifications
        WHERE email = ? AND verified_at IS NOT NULL AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (email,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Please verify this email before creating the account.")


def consume_verified_signup_email(connection, email: str) -> None:
    connection.execute(
        "UPDATE pending_email_verifications SET used_at = ? WHERE email = ? AND verified_at IS NOT NULL AND used_at IS NULL",
        (utc_now(), email),
    )


def validate_signup_payload(payload: SignupRequest) -> Dict[str, Any]:
    learner_age = payload.learner_age
    account_email = str(payload.email or "").strip().lower()
    account_name = payload.display_name.strip()
    parent_guardian_email = str(payload.parent_guardian_email or "").strip().lower()
    teacher_email = str(payload.teacher_email or "").strip().lower()

    if not account_name:
        raise HTTPException(status_code=400, detail="Name is required.")

    if payload.role == "teacher":
        if not account_email:
            raise HTTPException(status_code=400, detail="Mentor Email is required.")
        return {
            "account_email": account_email,
            "account_name": account_name,
            "parent_guardian_email": "",
            "teacher_email": "",
            "learner_age": None,
        }

    if learner_age is None:
        raise HTTPException(status_code=400, detail="Enter the age of the learner who will use PrepBro for studying.")
    if learner_age <= 0:
        raise HTTPException(status_code=400, detail="Learner age must be greater than 0.")
    if payload.daily_study_target_minutes is not None and payload.daily_study_target_minutes < 0:
        raise HTTPException(status_code=400, detail="Daily study target minutes must be 0 or more.")
    if learner_age < CHILD_AGE_THRESHOLD and not parent_guardian_email:
        raise HTTPException(status_code=400, detail="Parent/Guardian Email is required for learners under 13.")
    if learner_age >= CHILD_AGE_THRESHOLD and not account_email:
        raise HTTPException(status_code=400, detail="Learner Email is required.")

    if learner_age < CHILD_AGE_THRESHOLD:
        if parent_guardian_email and teacher_email and parent_guardian_email == teacher_email:
            raise HTTPException(status_code=400, detail="Parent/Guardian Email and Mentor Email must be different.")
    else:
        if account_email and parent_guardian_email and account_email == parent_guardian_email:
            raise HTTPException(status_code=400, detail="Learner Email and Parent/Guardian Email must be different.")
        if account_email and teacher_email and account_email == teacher_email:
            raise HTTPException(status_code=400, detail="Learner Email and Mentor Email must be different.")
        if parent_guardian_email and teacher_email and parent_guardian_email == teacher_email:
            raise HTTPException(status_code=400, detail="Parent/Guardian Email and Mentor Email must be different.")

    if learner_age < CHILD_AGE_THRESHOLD:
        account_email = parent_guardian_email

    return {
        "account_email": account_email,
        "account_name": account_name,
        "parent_guardian_email": parent_guardian_email,
        "teacher_email": teacher_email,
        "learner_age": learner_age,
    }


def validate_assignment_due_date(due_date_value: Optional[str]) -> Optional[str]:
    if due_date_value is None:
        return None
    due_date_text = str(due_date_value).strip()
    if not due_date_text:
        return None
    try:
        parsed = date.fromisoformat(due_date_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Please enter a valid due date.") from exc
    if parsed < date.today():
        raise HTTPException(status_code=400, detail="Assignment due date cannot be before today.")
    return due_date_text


def build_student_report(student: Dict[str, Any], progress: Dict[str, Any]) -> Dict[str, Any]:
    metadata = student.get("metadata") or {}
    report_lines = [
        "PrepBro Student Report",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"Student: {student['learner_name']}",
        f"Age: {student['learner_age'] if student['learner_age'] is not None else 'Not set'}",
        f"Gender: {metadata.get('gender') or 'Not set'}",
        f"Class/Grade: {student.get('class_level') or 'Not set'}",
        f"Daily Goal: {metadata.get('daily_study_target_minutes') or 0} minutes",
        f"Points: {progress['points']}",
        f"Streak: {progress['streak']}",
        f"Study Minutes: {progress['study_minutes']}",
        f"Quizzes Completed: {progress['quizzes_completed']}",
        f"Badges Achieved: {', '.join(progress['badges']) if progress['badges'] else 'None yet'}",
        "",
        "Recent progress summary:",
        f"- Last update: {progress['updated_at']}",
        f"- Last 7 days points entries: {len(progress['daily_points'])}",
        f"- Last 7 days study entries: {len(progress['daily_minutes'])}",
        f"- Assignments: {metadata.get('assignment_summary') or 'See mentor dashboard for live assignment list'}",
    ]
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", student["learner_name"]).strip("_") or "student"
    return {
        "filename": f"{safe_name}_prepbro_report.txt",
        "content_type": "text/plain",
        "report_text": "\n".join(report_lines),
    }


@app.post("/signup")
def signup(payload: SignupRequest) -> Dict[str, Any]:
    prepared = validate_signup_payload(payload)
    email = prepared["account_email"]
    account_name = prepared["account_name"]
    learner_age = prepared["learner_age"]
    parent_guardian_email = prepared["parent_guardian_email"]
    teacher_email = prepared["teacher_email"]

    with database.connect() as connection:
        existing = connection.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="An account with this email already exists.")
        require_verified_signup_email(connection, email)
        linked_teacher = None
        if payload.role == "student" and teacher_email:
            linked_teacher = get_teacher_user_by_email(connection, teacher_email)
            if not linked_teacher or linked_teacher["role"] != "teacher":
                raise HTTPException(status_code=400, detail="Mentor email not registered.")

        password_hash = hash_password(payload.password)
        created_at = utc_now()
        connection.execute(
            """
            INSERT INTO users (email, password_hash, role, is_verified, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (email, password_hash, payload.role, 1, created_at),
        )
        user_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

        preferences = normalize_preferences(
            learning_goal=payload.learning_goal,
            preferred_subjects=payload.preferred_subjects,
            daily_study_target_minutes=payload.daily_study_target_minutes,
            parent_guardian_email=parent_guardian_email,
            teacher_email=teacher_email,
            school_grade=payload.school_grade,
            school_organization=payload.school_organization,
            subject_department=payload.subject_department,
            extra=payload.preferences_json,
        )
        database.ensure_profile_record(
            connection,
            user_id=user_id,
            display_name=account_name,
            age=learner_age if payload.role == "student" else None,
            learning_goal=payload.learning_goal.strip(),
            preferences_json=preferences,
        )

        if payload.role == "student":
            student_id = database.ensure_self_student(
                connection,
                user_id=user_id,
                learner_name=account_name,
                learner_age=learner_age,
            )
            if linked_teacher:
                database.link_user_to_student(
                    connection,
                    student_id=student_id,
                    user_id=linked_teacher["id"],
                    relationship_type="teacher",
                )

        consume_verified_signup_email(connection, email)
        token, expires_at = create_access_token(user_id, email, settings)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_at": expires_at,
            "account_email": email,
            "user": serialize_user(connection, user_id),
            "progress": serialize_primary_progress(connection, {"id": user_id, "role": payload.role}),
            "students": list_students_for_user(connection, user_id),
            "email_verification": {
                "required": False,
                "is_verified": True,
                "sent": False,
            },
        }


@app.post("/login")
def login(payload: LoginRequest) -> Dict[str, Any]:
    email = payload.email.lower().strip()
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Please enter a valid email and password.")
    if not payload.password.strip():
        raise HTTPException(status_code=400, detail="Please enter a valid email and password.")
    with database.connect() as connection:
        row = connection.execute(
            "SELECT id, email, role, password_hash, is_verified FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password.")
        if not row["is_verified"]:
            raise HTTPException(status_code=403, detail="User account not verified. Please verify your email first.")
        token, expires_at = create_access_token(row["id"], row["email"], settings)
        user_payload = {"id": row["id"], "email": row["email"], "role": row["role"]}
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_at": expires_at,
            "user": serialize_user(connection, row["id"]),
            "progress": serialize_primary_progress(connection, user_payload),
            "students": list_students_for_user(connection, row["id"]),
        }


@app.post("/logout")
def logout(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    return {"ok": True, "message": f"Logged out user {current_user['id']}"}


@app.delete("/account")
@app.delete("/me")
def delete_account(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        connection.execute("DELETE FROM users WHERE id = ?", (current_user["id"],))
        return {"ok": True}


@app.get("/profile")
def get_profile(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        return serialize_user(connection, current_user["id"])


@app.put("/profile")
@app.post("/profile")
def save_profile(
    payload: ProfileUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    with database.connect() as connection:
        user = serialize_user(connection, current_user["id"])
        merged_preferences = dict(user.get("preferences_json") or {})
        merged_preferences.update(payload.preferences_json or {})
        if current_user["role"] == "student":
            student_email = str(user["email"] or "").strip().lower()
            parent_guardian_email = str(merged_preferences.get("parent_guardian_email") or "").strip().lower()
            teacher_email = str(merged_preferences.get("teacher_email") or "").strip().lower()
            email_values = [value for value in [student_email, parent_guardian_email, teacher_email] if value]
            if len(email_values) != len(set(email_values)):
                raise HTTPException(status_code=400, detail="Learner email, Parent/Guardian Email, and Mentor Email must all be different.")
            if teacher_email:
                teacher_row = get_teacher_user_by_email(connection, teacher_email)
                if not teacher_row or teacher_row["role"] != "teacher":
                    raise HTTPException(status_code=400, detail="Mentor email not registered.")
        if payload.learning_goal.strip():
            merged_preferences["learning_goal"] = payload.learning_goal.strip()
        connection.execute(
            """
            UPDATE profiles
            SET display_name = ?, age = ?, learning_goal = ?, preferences_json = ?
            WHERE user_id = ?
            """,
            (
                payload.display_name.strip() or user["display_name"],
                payload.age,
                payload.learning_goal.strip(),
                json.dumps(merged_preferences),
                current_user["id"],
            ),
        )
        if current_user["role"] == "student":
            student_id = get_primary_student_id(connection, current_user)
            if student_id is not None:
                connection.execute(
                    "UPDATE students SET learner_name = ?, learner_age = ? WHERE id = ?",
                    (payload.display_name.strip() or user["display_name"], payload.age, student_id),
                )
        return serialize_user(connection, current_user["id"])


@app.get("/progress")
def get_progress(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        return serialize_primary_progress(connection, current_user)


@app.put("/progress")
@app.post("/progress")
def save_progress(
    payload: ProgressUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            raise HTTPException(status_code=400, detail="No learner profile is linked to this account yet.")
        return upsert_progress(connection, student_id, payload)


@app.get("/students")
def get_students(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    with database.connect() as connection:
        return list_students_for_user(connection, current_user["id"])


@app.post("/students")
def create_student(
    payload: StudentCreateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    if current_user["role"] != "teacher":
        raise HTTPException(status_code=400, detail="Only mentor accounts can create learner profiles.")
    if payload.learner_age is not None and payload.learner_age <= 0:
        raise HTTPException(status_code=400, detail="Learner age must be greater than 0.")
    student_email = str(payload.student_email or "").strip().lower()
    parent_guardian_email = str(payload.parent_guardian_email or "").strip().lower()
    teacher_email = str(payload.teacher_email or current_user["email"]).strip().lower()
    if student_email and student_email == current_user["email"]:
        raise HTTPException(status_code=400, detail="A mentor cannot appear as their own learner.")
    email_values = [value for value in [student_email, parent_guardian_email, teacher_email] if value]
    if len(email_values) != len(set(email_values)):
        raise HTTPException(status_code=400, detail="Student email, Parent/Guardian Email, and Mentor Email must all be different.")
    preferences = normalize_preferences(
        learning_goal=payload.learning_goal,
        preferred_subjects=payload.preferred_subjects,
        daily_study_target_minutes=payload.daily_study_target_minutes,
        parent_guardian_email=parent_guardian_email,
        teacher_email=teacher_email,
        school_grade=payload.school_grade or payload.class_level,
        student_email=student_email,
        extra={"gender": payload.gender.strip()},
    )
    with database.connect() as connection:
        student_id = database.create_managed_student(
            connection,
            owner_user_id=current_user["id"],
            relationship_type="teacher",
            learner_name=payload.learner_name,
            learner_age=payload.learner_age,
            class_level=payload.school_grade or payload.class_level,
            metadata=preferences,
        )
        if payload.class_level or payload.school_grade:
            class_name = (payload.class_level or payload.school_grade).strip()
            class_row = connection.execute(
                "SELECT id FROM classes WHERE mentor_user_id = ? AND name = ? LIMIT 1",
                (current_user["id"], class_name),
            ).fetchone()
            if class_row:
                set_student_class_assignment(
                    connection,
                    mentor_user_id=current_user["id"],
                    student_id=student_id,
                    class_id=class_row["id"],
                )
        return get_authorized_student(connection, current_user, student_id) | {
            "progress": serialize_progress(connection, student_id),
        }


@app.get("/students/{student_id}")
def get_student(student_id: int, current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        student = get_authorized_student(connection, current_user, student_id)
        return student | {"progress": serialize_progress(connection, student_id)}


@app.put("/students/{student_id}")
def update_student(
    student_id: int,
    payload: StudentUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    with database.connect() as connection:
        student = get_authorized_student(connection, current_user, student_id)
        metadata = dict(student["metadata"] or {})
        if payload.learning_goal is not None:
            metadata["learning_goal"] = payload.learning_goal.strip()
        if payload.preferred_subjects is not None:
            metadata["preferred_subjects"] = [subject.strip() for subject in payload.preferred_subjects if subject.strip()]
        if payload.daily_study_target_minutes is not None:
            metadata["daily_study_target_minutes"] = payload.daily_study_target_minutes
        if payload.student_email is not None:
            metadata["student_email"] = str(payload.student_email)
        if payload.parent_guardian_email is not None:
            metadata["parent_guardian_email"] = str(payload.parent_guardian_email)
        if payload.teacher_email is not None:
            metadata["teacher_email"] = str(payload.teacher_email)
        if payload.gender is not None:
            metadata["gender"] = payload.gender.strip()
        connection.execute(
            """
            UPDATE students
            SET learner_name = ?,
                learner_age = ?,
                class_level = ?,
                metadata_json = ?
            WHERE id = ?
            """,
            (
                payload.learner_name.strip() if payload.learner_name is not None else student["learner_name"],
                payload.learner_age if payload.learner_age is not None else student["learner_age"],
                payload.class_level.strip() if payload.class_level is not None else student["class_level"],
                json.dumps(metadata),
                student_id,
            ),
        )
        if payload.class_level is not None:
            class_name = payload.class_level.strip()
            if not class_name:
                set_student_class_assignment(
                    connection,
                    mentor_user_id=current_user["id"],
                    student_id=student_id,
                    class_id=None,
                )
            else:
                class_row = connection.execute(
                    "SELECT id FROM classes WHERE mentor_user_id = ? AND name = ? LIMIT 1",
                    (current_user["id"], class_name),
                ).fetchone()
                if class_row:
                    set_student_class_assignment(
                        connection,
                        mentor_user_id=current_user["id"],
                        student_id=student_id,
                        class_id=class_row["id"],
                    )
        return get_authorized_student(connection, current_user, student_id) | {
            "progress": serialize_progress(connection, student_id),
        }


@app.delete("/students/{student_id}")
def delete_student(student_id: int, current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        student = get_authorized_student(connection, current_user, student_id)
        if student["relationship_type"] == "self":
            raise HTTPException(status_code=400, detail="Use account deletion to remove your own learner profile.")
        connection.execute("DELETE FROM students WHERE id = ?", (student_id,))
        return {"ok": True}


@app.get("/managed-students")
def managed_students(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    with database.connect() as connection:
        students = list_students_for_user(connection, current_user["id"])
        if current_user["role"] == "student":
            return [student for student in students if student["relationship_type"] == "self"]
        return students


@app.get("/classes")
@app.get("/mentor/classes")
def get_classes(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    require_mentor(current_user, "view classes")
    with database.connect() as connection:
        return list_classes_for_mentor(connection, current_user["id"])


@app.post("/classes")
@app.post("/mentor/classes")
def create_class(
    payload: ClassCreateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "create classes")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Class name is required.")
    with database.connect() as connection:
        existing = connection.execute(
            "SELECT id FROM classes WHERE mentor_user_id = ? AND lower(name) = lower(?)",
            (current_user["id"], name),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="A class with this name already exists.")
        created_at = utc_now()
        connection.execute(
            """
            INSERT INTO classes (
                mentor_user_id, name, grade_level, subject, description, schedule, academic_year, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_user["id"],
                name,
                payload.grade_level.strip(),
                payload.subject.strip(),
                payload.description.strip(),
                payload.schedule.strip(),
                payload.academic_year.strip(),
                created_at,
                created_at,
            ),
        )
        class_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        return get_authorized_class(connection, current_user["id"], class_id)


@app.put("/classes/{class_id}")
@app.put("/mentor/classes/{class_id}")
def update_class(
    class_id: int,
    payload: ClassUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "update classes")
    with database.connect() as connection:
        current = get_authorized_class(connection, current_user["id"], class_id)
        next_name = payload.name.strip() if payload.name is not None else current["name"]
        if not next_name:
            raise HTTPException(status_code=400, detail="Class name is required.")
        duplicate = connection.execute(
            "SELECT id FROM classes WHERE mentor_user_id = ? AND lower(name) = lower(?) AND id != ?",
            (current_user["id"], next_name, class_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="A class with this name already exists.")
        connection.execute(
            """
            UPDATE classes
            SET name = ?, grade_level = ?, subject = ?, description = ?, schedule = ?, academic_year = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_name,
                payload.grade_level.strip() if payload.grade_level is not None else current["grade_level"],
                payload.subject.strip() if payload.subject is not None else current["subject"],
                payload.description.strip() if payload.description is not None else current["description"],
                payload.schedule.strip() if payload.schedule is not None else current["schedule"],
                payload.academic_year.strip() if payload.academic_year is not None else current["academic_year"],
                utc_now(),
                class_id,
            ),
        )
        return get_authorized_class(connection, current_user["id"], class_id)


@app.delete("/classes/{class_id}")
@app.delete("/mentor/classes/{class_id}")
def delete_class(class_id: int, current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    require_mentor(current_user, "delete classes")
    with database.connect() as connection:
        get_authorized_class(connection, current_user["id"], class_id)
        connection.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        connection.execute("UPDATE students SET class_level = '' WHERE id NOT IN (SELECT student_id FROM student_class_links)")
        return {"ok": True}


@app.put("/students/{student_id}/class")
@app.put("/mentor/learners/{student_id}/class")
def update_student_class(
    student_id: int,
    payload: ClassAssignmentRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "manage class assignments")
    with database.connect() as connection:
        return set_student_class_assignment(
            connection,
            mentor_user_id=current_user["id"],
            student_id=student_id,
            class_id=payload.class_id,
        )


@app.get("/students/{student_id}/progress")
def get_student_progress(student_id: int, current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        get_authorized_student(connection, current_user, student_id)
        return serialize_progress(connection, student_id)


@app.get("/students/{student_id}/report")
def get_student_report(student_id: int, current_user: Dict[str, Any] = Depends(current_user_dependency)) -> Dict[str, Any]:
    with database.connect() as connection:
        student = get_authorized_student(connection, current_user, student_id)
        progress = serialize_progress(connection, student_id)
        assignment_rows = connection.execute(
            """
            SELECT a.title, a.due_date, at.status
            FROM assignment_targets at
            INNER JOIN assignments a ON a.id = at.assignment_id
            WHERE at.student_id = ?
            ORDER BY a.created_at DESC
            """,
            (student_id,),
        ).fetchall()
        student["metadata"] = {
            **(student.get("metadata") or {}),
            "assignment_summary": ", ".join(
                [
                    f"{row['title']} ({row['status']}{', due ' + row['due_date'] if row['due_date'] else ''})"
                    for row in assignment_rows
                ]
            ) if assignment_rows else "No assignments",
        }
        return build_student_report(student, progress)


@app.get("/assignments")
@app.get("/mentor/assignments")
def get_assignments(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    require_mentor(current_user, "view assignments")
    with database.connect() as connection:
        return list_assignments_for_mentor(connection, current_user["id"])


@app.get("/mentor/assignments/{assignment_id}")
def get_assignment_details(
    assignment_id: int,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "view assignments")
    with database.connect() as connection:
        get_authorized_assignment_for_mentor(connection, current_user["id"], assignment_id)
        return get_assignment_for_mentor(connection, current_user["id"], assignment_id)


@app.post("/assignments")
@app.post("/mentor/assignments")
def create_assignment(
    payload: AssignmentCreateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "create assignments")
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Assignment title is required.")
    due_date_value = validate_assignment_due_date(payload.due_date)
    with database.connect() as connection:
        target_ids = resolve_assignment_target_ids(
            connection,
            mentor_user_id=current_user["id"],
            assign_to_all=payload.assign_to_all,
            class_id=payload.class_id,
            student_ids=payload.student_ids,
        )
        if not target_ids:
            raise HTTPException(status_code=400, detail="Select at least one learner for this assignment.")
        created_at = utc_now()
        connection.execute(
            """
            INSERT INTO assignments (
                teacher_user_id,
                owner_user_id,
                assignment_type,
                title,
                description,
                due_date,
                class_id,
                priority,
                created_at,
                updated_at
            )
            VALUES (?, NULL, 'mentor_assigned', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_user["id"],
                title,
                payload.description.strip(),
                due_date_value,
                payload.class_id,
                payload.priority.strip(),
                created_at,
                created_at,
            ),
        )
        assignment_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        for student_id in target_ids:
            connection.execute(
                """
                INSERT INTO assignment_targets (
                    assignment_id,
                    student_id,
                    status,
                    created_at,
                    seen_at,
                    completed_at,
                    marks_obtained,
                    max_marks,
                    feedback,
                    graded_at
                )
                VALUES (?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, NULL)
                """,
                (assignment_id, student_id, created_at),
            )
        return {"ok": True, "assignment_id": assignment_id, "assignment": get_assignment_for_mentor(connection, current_user["id"], assignment_id)}


@app.put("/mentor/assignments/{assignment_id}")
def update_assignment(
    assignment_id: int,
    payload: AssignmentUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "update assignments")
    with database.connect() as connection:
        current = get_authorized_assignment_for_mentor(connection, current_user["id"], assignment_id)
        title = payload.title.strip() if payload.title is not None else current["title"]
        if not title:
            raise HTTPException(status_code=400, detail="Assignment title is required.")
        due_date_value = validate_assignment_due_date(payload.due_date if payload.due_date is not None else current["due_date"])
        target_ids = resolve_assignment_target_ids(
            connection,
            mentor_user_id=current_user["id"],
            assign_to_all=payload.assign_to_all,
            class_id=payload.class_id if payload.class_id is not None else current["class_id"],
            student_ids=payload.student_ids or [],
        )
        if not target_ids:
            raise HTTPException(status_code=400, detail="Select at least one learner for this assignment.")
        connection.execute(
            """
            UPDATE assignments
            SET title = ?, description = ?, due_date = ?, class_id = ?, priority = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                payload.description.strip() if payload.description is not None else current["description"],
                due_date_value,
                payload.class_id if payload.class_id is not None else current["class_id"],
                payload.priority.strip() if payload.priority is not None else current["priority"],
                utc_now(),
                assignment_id,
            ),
        )
        connection.execute("DELETE FROM assignment_targets WHERE assignment_id = ?", (assignment_id,))
        for student_id in target_ids:
            connection.execute(
                """
                INSERT INTO assignment_targets (
                    assignment_id,
                    student_id,
                    status,
                    created_at,
                    seen_at,
                    completed_at,
                    marks_obtained,
                    max_marks,
                    feedback,
                    graded_at
                )
                VALUES (?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, NULL)
                """,
                (assignment_id, student_id, utc_now()),
            )
        updated = get_assignment_for_mentor(connection, current_user["id"], assignment_id)
        return {"ok": True, "assignment": updated}


@app.delete("/mentor/assignments/{assignment_id}")
def delete_assignment(
    assignment_id: int,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "delete assignments")
    with database.connect() as connection:
        get_authorized_assignment_for_mentor(connection, current_user["id"], assignment_id)
        connection.execute("DELETE FROM assignments WHERE id = ?", (assignment_id,))
        return {"ok": True}


@app.put("/mentor/assignments/{assignment_id}/targets/{student_id}/grade")
def grade_assignment_target(
    assignment_id: int,
    student_id: int,
    payload: AssignmentGradeUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_mentor(current_user, "grade assignments")
    with database.connect() as connection:
        get_authorized_assignment_for_mentor(connection, current_user["id"], assignment_id)
        get_managed_student_for_mentor(connection, current_user["id"], student_id)
        target = connection.execute(
            """
            SELECT id
            FROM assignment_targets
            WHERE assignment_id = ? AND student_id = ?
            LIMIT 1
            """,
            (assignment_id, student_id),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Assignment target not found for this learner.")
        if payload.marks_obtained is not None and payload.marks_obtained < 0:
            raise HTTPException(status_code=400, detail="Marks obtained must be 0 or more.")
        if payload.max_marks is not None and payload.max_marks <= 0:
            raise HTTPException(status_code=400, detail="Maximum marks must be greater than 0.")
        if (
            payload.marks_obtained is not None
            and payload.max_marks is not None
            and payload.marks_obtained > payload.max_marks
        ):
            raise HTTPException(status_code=400, detail="Marks obtained cannot be greater than maximum marks.")
        graded_at = utc_now() if (
            payload.marks_obtained is not None
            or payload.max_marks is not None
            or payload.feedback.strip()
        ) else None
        connection.execute(
            """
            UPDATE assignment_targets
            SET marks_obtained = ?, max_marks = ?, feedback = ?, graded_at = ?
            WHERE assignment_id = ? AND student_id = ?
            """,
            (
                payload.marks_obtained,
                payload.max_marks,
                payload.feedback.strip() or None,
                graded_at,
                assignment_id,
                student_id,
            ),
        )
        return {
            "ok": True,
            "assignment": get_assignment_for_mentor(connection, current_user["id"], assignment_id),
        }


@app.get("/student/assignments")
def get_student_assignments(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    require_student(current_user, "view assignments")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            return []
        return list_assignments_for_student(connection, student_id)


@app.put("/student/assignments/{assignment_id}/seen")
def mark_student_assignment_seen(
    assignment_id: int,
    payload: StudentAssignmentSeenRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_student(current_user, "view assignments")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            raise HTTPException(status_code=400, detail="No learner profile is linked to this account yet.")
        target = connection.execute(
            """
            SELECT at.id, a.assignment_type
            FROM assignment_targets at
            INNER JOIN assignments a ON a.id = at.assignment_id
            WHERE assignment_id = ? AND student_id = ?
            LIMIT 1
            """,
            (assignment_id, student_id),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=403, detail="You can only view assignments assigned to your learner account.")
        connection.execute(
            "UPDATE assignment_targets SET seen_at = ? WHERE assignment_id = ? AND student_id = ?",
            (utc_now() if payload.seen else None, assignment_id, student_id),
        )
        updated = next((item for item in list_assignments_for_student(connection, student_id) if item["id"] == assignment_id), None)
        return {"ok": True, "assignment": updated}


@app.put("/student/assignments/{assignment_id}/status")
def update_student_assignment_status(
    assignment_id: int,
    payload: AssignmentStatusUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_student(current_user, "update assignment status")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            raise HTTPException(status_code=400, detail="No learner profile is linked to this account yet.")
        assignment_exists = connection.execute(
            "SELECT id FROM assignments WHERE id = ?",
            (assignment_id,),
        ).fetchone()
        if not assignment_exists:
            raise HTTPException(status_code=404, detail="Assignment not found.")
        target = connection.execute(
            """
            SELECT at.id, a.assignment_type
            FROM assignment_targets at
            INNER JOIN assignments a ON a.id = at.assignment_id
            WHERE assignment_id = ? AND student_id = ?
            LIMIT 1
            """,
            (assignment_id, student_id),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=403, detail="You can only update assignments assigned to your learner account.")
        completed_at = utc_now() if payload.status == "completed" else None
        connection.execute(
            """
            UPDATE assignment_targets
            SET status = ?, completed_at = ?, seen_at = COALESCE(seen_at, ?)
            WHERE assignment_id = ? AND student_id = ?
            """,
            (payload.status, completed_at, utc_now(), assignment_id, student_id),
        )
        if target["assignment_type"] == "self_assigned":
            updated = next((item for item in list_self_goals_for_student(connection, current_user, student_id) if item["id"] == assignment_id), None)
        else:
            updated = next((item for item in list_assignments_for_student(connection, student_id) if item["id"] == assignment_id), None)
        return {"ok": True, "assignment": updated}


@app.get("/student/self-goals")
def get_student_self_goals(current_user: Dict[str, Any] = Depends(current_user_dependency)) -> List[Dict[str, Any]]:
    require_student(current_user, "view goals")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            return []
        return list_self_goals_for_student(connection, current_user, student_id)


@app.post("/student/self-goals")
def create_student_self_goal(
    payload: SelfGoalCreateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_student(current_user, "create goals")
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Goal title is required.")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            raise HTTPException(status_code=400, detail="No learner profile is linked to this account yet.")
        created_at = utc_now()
        connection.execute(
            """
            INSERT INTO assignments (
                teacher_user_id,
                owner_user_id,
                assignment_type,
                title,
                description,
                due_date,
                class_id,
                priority,
                created_at,
                updated_at
            )
            VALUES (?, ?, 'self_assigned', ?, ?, ?, NULL, ?, ?, ?)
            """,
            (
                current_user["id"],
                current_user["id"],
                title,
                payload.description.strip(),
                payload.due_date,
                payload.priority.strip(),
                created_at,
                created_at,
            ),
        )
        goal_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO assignment_targets (assignment_id, student_id, status, created_at, seen_at, completed_at)
            VALUES (?, ?, 'pending', ?, ?, NULL)
            """,
            (goal_id, student_id, created_at, created_at),
        )
        created = next((item for item in list_self_goals_for_student(connection, current_user, student_id) if item["id"] == goal_id), None)
        return {"ok": True, "goal": created}


@app.put("/student/self-goals/{goal_id}")
def update_student_self_goal(
    goal_id: int,
    payload: SelfGoalUpdateRequest,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_student(current_user, "update goals")
    with database.connect() as connection:
        student_id = get_primary_student_id(connection, current_user)
        if student_id is None:
            raise HTTPException(status_code=400, detail="No learner profile is linked to this account yet.")
        current = get_authorized_self_goal(connection, current_user["id"], goal_id)
        title = payload.title.strip() if payload.title is not None else current["title"]
        if not title:
            raise HTTPException(status_code=400, detail="Goal title is required.")
        connection.execute(
            """
            UPDATE assignments
            SET title = ?, description = ?, due_date = ?, priority = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                payload.description.strip() if payload.description is not None else current["description"],
                payload.due_date if payload.due_date is not None else current["due_date"],
                payload.priority.strip() if payload.priority is not None else current["priority"],
                utc_now(),
                goal_id,
            ),
        )
        updated = next((item for item in list_self_goals_for_student(connection, current_user, student_id) if item["id"] == goal_id), None)
        return {"ok": True, "goal": updated}


@app.delete("/student/self-goals/{goal_id}")
def delete_student_self_goal(
    goal_id: int,
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    require_student(current_user, "delete goals")
    with database.connect() as connection:
        get_authorized_self_goal(connection, current_user["id"], goal_id)
        connection.execute("DELETE FROM assignments WHERE id = ?", (goal_id,))
        return {"ok": True}


@app.post("/verification/send")
@app.post("/email/send-verification")
def send_verification(
    current_user: Dict[str, Any] = Depends(current_user_dependency),
) -> Dict[str, Any]:
    with database.connect() as connection:
        return send_verification_response(connection, current_user["id"], current_user["email"])


@app.post("/verification/request-signup")
def request_signup_verification(payload: SignupEmailVerificationRequest) -> Dict[str, Any]:
    email = str(payload.email).strip().lower()
    with database.connect() as connection:
        return send_signup_email_verification_response(connection, email, payload.draft)


@app.post("/verification/verify")
def verify_email(payload: VerificationRequest) -> Dict[str, Any]:
    with database.connect() as connection:
        return verify_email_token(connection, payload.token)


@app.get("/email/verify")
def verify_email_get(token: str = Query(...)) -> Dict[str, Any]:
    with database.connect() as connection:
        return verify_email_token(connection, token)


class ExtractRequest(pydantic.BaseModel):
    file_b64: str
    filename: str = "file"


@app.post("/api/extract-text")
async def api_extract_text(req: ExtractRequest) -> Dict[str, str]:
    """Accept JSON body: { "file_b64": "<base64>", "filename": "doc.pdf" }
    Decodes and extracts text from PDF, DOCX, or TXT — no python-multipart needed.
    """
    try:
        import base64 as _base64
        from io import BytesIO
        raw = _base64.b64decode(req.file_b64)
        name = req.filename.lower()

        if name.endswith(".pdf"):
            from pypdf import PdfReader
            from app.services.extract import clean_pdf_text
            reader = PdfReader(BytesIO(raw))
            parts = [page.extract_text() or "" for page in reader.pages]
            text = clean_pdf_text("\n\n".join(p for p in parts if p.strip()))
        elif name.endswith(".docx"):
            from docx import Document
            doc = Document(BytesIO(raw))
            text = "\n".join(p.text.strip() for p in doc.paragraphs if p.text.strip())
        elif name.endswith((".txt", ".md")):
            try:
                text = raw.decode("utf-8")
            except Exception:
                text = raw.decode("latin-1", errors="ignore")
        else:
            try:
                text = raw.decode("utf-8")
            except Exception:
                text = raw.decode("latin-1", errors="ignore")

        return {"text": text}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract text: {str(e)}") from e


@app.post("/api/simplify")
async def api_simplify(payload: Dict[str, Any]) -> Dict[str, Any]:
    text = (payload.get("text") or "").strip()
    mode = payload.get("mode", "text")
    is_pdf = payload.get("is_pdf", False)
    raw_file_b64 = payload.get("file_b64")

    images = []
    if is_pdf and raw_file_b64:
        try:
            pdf_bytes = base64.b64decode(raw_file_b64)
            images = await pdf_to_base64_images(pdf_bytes)
            images = images[:3]
        except Exception as e:
            print(f"Vision processing failed: {e}")

    system_prompt = (
        "You are a warm, clear tutor helping a student learn effectively. "
        "You MUST return ONLY a valid JSON object. "
        "Start your response with { and end with }. "
        "No markdown code fences like ```json, no explanation before or after the JSON."
    )

    # Use the text as a separate user message
    if images:
        input_part = "Please analyse the attached study material images."
    else:
        input_part = text

    instructions = (
        "Analyze the text and return a JSON object with these 8 keys:\n\n"
        "```json\n"
        "{\n"
        '  "simplified": "string - max 400 words",\n'
        '  "keypoints": ["array of 6-8 short phrases"],\n'
        '  "examples": ["array of 2-3 examples"],\n'
        '  "mindmap": "string - Mermaid syntax",\n'
        '  "summary": "string - exactly 3 sentences",\n'
        '  "layman": "string - 2-3 simple sentences",\n'
        '  "visuals": ["array of 2-3 image prompts"],\n'
        '  "abbreviations": [{"short":"str","full":"str"}]\n'
        "}\n"
        "```\n\n"
        "FIELD REQUIREMENTS:\n"
        "• simplified: Plain language rewrite (max 400 words). Use **bold** for key terms. Short paragraphs.\n"
        "• keypoints: 6-8 bullet facts, each under 10 words\n"
        "• examples: 2-3 concrete examples\n"
        "• summary: Exactly 3 short sentences\n"
        "• layman: Explain like to a 10-year-old (2-3 sentences)\n"
        "• mindmap: Mermaid mindmap code starting with 'mindmap\\n  root\\n    branch1\\n    branch2'\n"
        "• visuals: 2-3 short image descriptions (under 12 words each)\n"
        "• abbreviations: Any acronyms found, or empty array []\n\n"
        "CRITICAL: Your response must be ONLY the JSON object. Start with { and end with }.\n\n"
        "TEXT TO ANALYZE:\n"
    )

    user_message = instructions + input_part

    try:
        # Don't use response_format_json - it's too strict for Groq
        if images:
            content = await ai.chat_vision(
                system=system_prompt,
                user=instructions,
                images=images,
            )
        else:
            content = await ai.chat_text(
                system=system_prompt,
                user=user_message,
                response_format_json=False,  # Changed to False
            )

        # Clean up the response
        content = content.strip()
        
        # Remove markdown code fences if present
        if content.startswith("```"):
            # Find the first { and last }
            start_idx = content.find("{")
            end_idx = content.rfind("}")
            if start_idx != -1 and end_idx != -1:
                content = content[start_idx:end_idx + 1]
        
        print(f"Cleaned content (first 300 chars): {content[:300]}")
        
        # Try to parse the JSON response
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as json_err:
            print(f"JSON decode error: {json_err}")
            print(f"Full response: {content}")
            
            # Try to extract JSON from the response
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    print("Successfully extracted JSON from response")
                except Exception as e2:
                    print(f"Failed to parse extracted JSON: {e2}")
                    raise HTTPException(
                        status_code=500, 
                        detail="AI returned incomplete JSON. Try with shorter text."
                    )
            else:
                raise HTTPException(
                    status_code=500, 
                    detail="AI did not return valid JSON format."
                )
        
        # Validate and return response
        return {
            "simplified":    parsed.get("simplified", ""),
            "keypoints":     parsed.get("keypoints", []) if isinstance(parsed.get("keypoints"), list) else [],
            "examples":      parsed.get("examples", []) if isinstance(parsed.get("examples"), list) else [],
            "mindmap":       parsed.get("mindmap", ""),
            "summary":       parsed.get("summary", ""),
            "layman":        parsed.get("layman", ""),
            "visuals":       parsed.get("visuals", []) if isinstance(parsed.get("visuals"), list) else [],
            "abbreviations": parsed.get("abbreviations", []) if isinstance(parsed.get("abbreviations"), list) else [],
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Simplification error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to simplify: {str(e)}") from e


@app.post("/api/mindmap")
async def api_mindmap(payload: Dict[str, Any]) -> Dict[str, str]:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="Missing or invalid 'text'")

    prompt = f"""
Create a Mermaid mindmap for this text.

Requirements:
- Output ONLY Mermaid mindmap syntax.
- Start with: mindmap
- Use short words/phrases.
- Use 1 central topic and 3–6 branches.

Text:
\"\"\"{text}\"\"\"
"""
    try:
        mermaid = await ai.chat_text(
            system="Return only Mermaid mindmap syntax. No markdown.",
            user=prompt,
            response_format_json=False,
        )
        mermaid = mermaid.strip().replace("```mermaid", "").replace("```", "").strip()
        return {"mermaid": mermaid}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to generate mindmap") from e


@app.post("/api/quiz")
async def api_quiz(payload: Dict[str, Any]) -> Dict[str, Any]:
    text = payload.get("text")
    count = payload.get("count", 6)
    exclude = payload.get("exclude", [])
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="Missing or invalid 'text'")

    try:
        n = int(count)
    except Exception:
        n = 6
    n = max(3, min(12, n))

    exclude_note = f"\nIMPORTANT: Do NOT repeat these already-asked questions: {exclude}" if exclude else ""

    prompt = f"""
Create a quiz from this study text for a student.

Return ONLY valid JSON with this shape:
{{
  "questions": [
    {{
      "question": string,
      "choices": string[],
      "answerIndex": number,
      "explanation": string
    }}
  ]
}}

Rules:
- Create exactly {n} DIFFERENT questions.
- Each question must have 4 choices.
- Keep questions short and clear.
- Explanations must be simple (1 sentence).
- Ask about different aspects of the text.{exclude_note}

Study text:
\"\"\"{text}\"\"\"
"""

    fallback_quiz = _build_local_quiz(text, n)

    try:
        content = await ai.chat_text(
            system="Return only valid JSON. No markdown.",
            user=prompt,
            response_format_json=True,
        )
        parsed = safe_json_loads(content)
        questions = parsed.get("questions")
        if not isinstance(questions, list) or not questions:
            return fallback_quiz

        cleaned_questions: List[Dict[str, Any]] = []
        for item in questions[:n]:
            if not isinstance(item, dict):
                continue
            question = str(item.get("question", "")).strip()
            choices = item.get("choices")
            explanation = str(item.get("explanation", "")).strip()
            if not question or not isinstance(choices, list) or len(choices) != 4:
                continue
            normalized_choices = [str(choice).strip() for choice in choices]
            try:
                answer_index = int(item.get("answerIndex", 0))
            except Exception:
                answer_index = 0
            if answer_index < 0 or answer_index >= len(normalized_choices):
                answer_index = 0
            cleaned_questions.append({
                "question": question,
                "choices": normalized_choices,
                "answerIndex": answer_index,
                "explanation": explanation or "Review the study text for the correct answer.",
            })

        if not cleaned_questions:
            return fallback_quiz
        return {"questions": cleaned_questions}
    except Exception:
        return fallback_quiz


@app.post("/api/assistant")
async def api_assistant(payload: Dict[str, Any]) -> Dict[str, str]:
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="Missing or invalid 'message'")

    # Classify the message type
    msg_lower = message.lower().strip()
    is_greeting = any(w in msg_lower for w in ["hello","hi","hey","hai","hii","helo","sup","howdy"])
    
    if is_greeting:
        system = "You are a friendly AI study assistant. Respond to greetings with exactly 1-2 sentences. Be warm and brief. No lists. No emojis spam."
        user_prompt = f"Student said: '{message}'. Reply with a short, warm greeting (1-2 sentences max)."
    else:
        system = "You are a concise AI study assistant for a student. Give clear, direct answers. Use simple language. Max 4-5 short sentences or 3-4 bullet points. No long paragraphs."
        user_prompt = f"""Answer this student question clearly and briefly:
"{message}"

Rules:
- Max 4-5 sentences OR 3-4 short bullet points
- Simple language, short sentences
- Be encouraging but brief
- 1 emoji maximum"""

    try:
        answer = await ai.chat_text(
            system=system,
            user=user_prompt,
            response_format_json=False,
        )
        return {"answer": answer.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to answer") from e


@app.post("/api/image")
async def api_image(payload: Dict[str, Any]) -> Dict[str, Optional[str]]:
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(status_code=400, detail="Missing or invalid 'prompt'")

    try:
        completion = await ai.chat_image_gen(prompt=prompt)
        image_data_url = extract_image_data_url_from_chat(completion)
        return {"imageDataUrl": image_data_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to generate image") from e


@app.get("/api/quote")
async def api_quote() -> Dict[str, str]:
    import random
    themes = [
        "about perseverance", "about curiosity", "about growth", "about courage",
        "about effort", "about learning from mistakes", "about believing in yourself",
        "about small steps leading to big results", "about kindness to yourself",
        "about the joy of discovery", "about never giving up", "about potential",
    ]
    theme = random.choice(themes)
    prompt = f"Give me one short, original, inspiring motivational quote {theme}. Make it unique and uplifting. No hashtags. Do not mention any learning conditions or disabilities."
    try:
        quote = await ai.chat_text(
            system="You are a warm, encouraging mentor. Give a single fresh motivational quote — never repeat the same quote twice.",
            user=prompt,
            response_format_json=False
        )
        return {"quote": quote.strip()}
    except Exception:
        fallbacks = [
            "Believe in yourself — you are capable of amazing things! 🌟",
            "Every step forward is a victory worth celebrating. ✨",
            "Your effort today is building a better tomorrow. 💪",
            "Keep going — great things take time and you are worth it. 🚀",
        ]
        return {"quote": random.choice(fallbacks)}

@app.post("/api/smart-schedule")
async def api_smart_schedule(payload: Dict[str, Any]) -> Dict[str, Any]:
    subjects = payload.get("subjects", [])
    hours_per_day = payload.get("hours_per_day", payload.get("hours", 2))
    priority_subjects = payload.get("priority_subjects", [])
    study_days = payload.get("study_days", ["Mon","Tue","Wed","Thu","Fri"])
    document_text = payload.get("document_text", "")

    days_str = ", ".join(study_days) if study_days else "Monday to Friday"
    subjects_str = ", ".join(subjects) if subjects else "General study"
    priority_str = ", ".join(priority_subjects) if priority_subjects else "none specified"
    doc_snippet = document_text[:3000] if document_text else ""

    prompt = f"""
Create a smart, adaptive weekly study schedule for a student.

INPUT:
- Subjects to study: {subjects_str}
- Priority subjects (give more time): {priority_str}
- Study days: {days_str}
- Available hours per day: {hours_per_day}
- Document content (if provided, use headings to structure topics): {doc_snippet}

RULES:
1. Each study session should be 20-35 minutes (dyslexic students need shorter focused sessions).
2. ALWAYS include 5-minute breaks between study sessions.
3. Prioritize subjects marked as priority by giving them more sessions per week.
4. If document_text is provided: extract headings/topics and allocate time proportional to content length.
5. Spread sessions across the provided study days.
6. Sessions start at 09:00 and continue sequentially.
7. Include variety - alternate subjects where possible.

Return ONLY valid JSON in this EXACT format (no markdown, no backticks):
{{
  "schedule": [
    {{
      "day": "Monday",
      "sessions": [
        {{ "subject": "Math", "startTime": "09:00", "duration": "30 min", "type": "study" }},
        {{ "subject": "Break", "startTime": "09:30", "duration": "5 min", "type": "break" }},
        {{ "subject": "Science", "startTime": "09:35", "duration": "25 min", "type": "study" }}
      ]
    }}
  ]
}}

IMPORTANT: Always include "type" field - either "study" or "break". Include at least one break per day.
"""
    try:
        raw = await ai.chat_text(
            system="You are an expert educational planner specializing in adaptive study schedules. Return only valid JSON.",
            user=prompt,
            response_format_json=True
        )
        parsed = safe_json_loads(raw)
        schedule = parsed.get("schedule", [])
        if not schedule:
            raise ValueError("Empty schedule returned")
        return {"schedule": schedule}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create schedule: {str(e)}") from e

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)


@app.get("/api/story")
async def api_story(used: str = "") -> dict:
    used_list = [s.strip() for s in used.split("||") if s.strip()]
    exclude_note = f"\nDo NOT tell any of these stories again (titles): {', '.join(used_list[:10])}" if used_list else ""
    prompt = f"""Tell a short, fun story for a child (8-14 years old). 
Choose randomly between: a funny story OR a moral story OR an adventure story.
The story must be completely original and unique each time.{exclude_note}

Return ONLY valid JSON:
{{
  "title": string,
  "type": "funny" | "moral" | "adventure",
  "story": string,
  "moral": string  
}}

Rules:
- story: 150-200 words, simple language, engaging
- moral: one short sentence (the lesson). If funny, make it light-hearted.
- Keep it age-appropriate and positive"""
    try:
        raw = await ai.chat_text(
            system="You are a creative storyteller for children. Return only valid JSON.",
            user=prompt,
            response_format_json=True
        )
        parsed = safe_json_loads(raw)
        return {
            "title": parsed.get("title", "A Fun Story"),
            "type": parsed.get("type", "funny"),
            "story": parsed.get("story", ""),
            "moral": parsed.get("moral", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to generate story") from e


@app.post("/api/references")
async def api_references(payload: dict) -> dict:
    topic = payload.get("topic", "")
    keywords = payload.get("keywords", [])
    if not topic and not keywords:
        raise HTTPException(status_code=400, detail="Provide topic or keywords")
    
    kw_str = ", ".join(keywords[:8]) if keywords else topic
    prompt = f"""Generate useful reference resources for a student studying this topic: "{kw_str}"

Return ONLY valid JSON:
{{
  "youtube": [
    {{"title": string, "channel": string, "url": string, "desc": string}}
  ],
  "websites": [
    {{"title": string, "url": string, "desc": string}}
  ]
}}

Rules:
- youtube: 3-4 real, well-known educational YouTube videos (Khan Academy, CrashCourse, TED-Ed, Kurzgesagt, etc.)
- websites: 3-4 real, reputable educational websites (Wikipedia, BBC Bitesize, Khan Academy, NASA, National Geographic, etc.)
- Only include REAL URLs that actually exist
- Keep descriptions short (1 sentence)"""
    try:
        raw = await ai.chat_text(
            system="You are a helpful librarian. Return only valid JSON with real educational links.",
            user=prompt,
            response_format_json=True
        )
        parsed = safe_json_loads(raw)
        return {
            "youtube": parsed.get("youtube", []),
            "websites": parsed.get("websites", []),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to fetch references") from e


@app.post("/api/revision-schedule")
async def api_revision_schedule(payload: dict) -> dict:
    original_schedule = payload.get("original_schedule", [])
    hours_per_day = payload.get("hours_per_day", 1.5)
    study_days = payload.get("study_days", ["Mon", "Tue", "Wed", "Thu", "Fri"])

    # Extract ALL unique subjects with their average session duration
    subject_map = {}
    for day in original_schedule:
        for s in day.get("sessions", []):
            if s.get("type") != "break":
                subj = s["subject"]
                dur = s.get("duration", "30 min")
                m = re.search(r"(\d+)", str(dur))
                mins = int(m.group(1)) if m else 30
                if subj not in subject_map:
                    subject_map[subj] = []
                subject_map[subj].append(mins)

    if not subject_map:
        raise HTTPException(status_code=400, detail="No subjects found in original schedule")

    # ALL subjects must appear — revision time = 50-60% of original average
    subjects_str = ""
    for subj, durations in subject_map.items():
        avg = sum(durations) // len(durations)
        rev = max(10, int(avg * 0.55))
        subjects_str += f"- {subj}: was ~{avg} min → revise in {rev} min\n"

    days_str = ", ".join(study_days)
    n_days = len(study_days)

    prompt = f"""Create a REVISION study schedule that covers ALL the listed subjects.

ALL SUBJECTS TO REVISE (every single one must appear):
{subjects_str}

SETTINGS:
- Study days: {days_str} ({n_days} days total)
- Hours available per day: {hours_per_day}
- Start time: 09:00

STRICT RULES:
1. EVERY subject listed above MUST appear at least once in the schedule
2. Revision sessions: 10-20 minutes only (shorter than original learning)
3. Add a 5-minute break after every 2 study sessions
4. Distribute subjects as evenly as possible across all {n_days} days
5. If a subject can't fit on one day, put it on the next day
6. Label subjects clearly as "X Revision" (e.g. "Math Revision")

Return ONLY valid JSON:
{{
  "schedule": [
    {{
      "day": "Monday",
      "sessions": [
        {{ "subject": "Math Revision", "startTime": "09:00", "duration": "15 min", "type": "study" }},
        {{ "subject": "Science Revision", "startTime": "09:15", "duration": "12 min", "type": "study" }},
        {{ "subject": "Break", "startTime": "09:27", "duration": "5 min", "type": "break" }}
      ]
    }}
  ]
}}"""
    try:
        raw = await ai.chat_text(
            system="You are an expert study planner. Return only valid JSON.",
            user=prompt,
            response_format_json=True
        )
        parsed = safe_json_loads(raw)
        return {"schedule": parsed.get("schedule", [])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create revision schedule: {e}") from e

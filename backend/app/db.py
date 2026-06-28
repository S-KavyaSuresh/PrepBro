from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.config import Settings


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_sqlite_path(database_url: str) -> Path:
    if database_url.startswith("sqlite:///"):
        raw_path = database_url.removeprefix("sqlite:///")
    else:
        raw_path = database_url
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _safe_json_loads(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


class Database:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.path = resolve_sqlite_path(settings.database_url)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            self._create_user_tables(connection)
            self._create_student_tables(connection)
            self._migrate_legacy_progress(connection)
            self._create_progress_table(connection)
            self._create_class_tables(connection)
            self._create_assignment_tables(connection)
            self._backfill_student_records(connection)

    def _create_user_tables(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'student',
                is_verified INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                user_id INTEGER PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                age INTEGER NULL,
                learning_goal TEXT NOT NULL DEFAULT '',
                preferences_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS verification_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_email_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                token TEXT NOT NULL UNIQUE,
                draft_json TEXT NOT NULL DEFAULT '{}',
                expires_at TEXT NOT NULL,
                verified_at TEXT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        self._ensure_columns(
            connection,
            "users",
            {
                "password_hash": "TEXT NOT NULL DEFAULT ''",
                "role": "TEXT NOT NULL DEFAULT 'student'",
                "is_verified": "INTEGER NOT NULL DEFAULT 0",
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self._ensure_columns(
            connection,
            "profiles",
            {
                "display_name": "TEXT NOT NULL DEFAULT ''",
                "age": "INTEGER NULL",
                "learning_goal": "TEXT NOT NULL DEFAULT ''",
                "preferences_json": "TEXT NOT NULL DEFAULT '{}'",
            },
        )
        self._ensure_columns(
            connection,
            "verification_tokens",
            {
                "token": "TEXT NOT NULL DEFAULT ''",
                "expires_at": "TEXT NOT NULL DEFAULT ''",
                "used_at": "TEXT NULL",
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self._ensure_columns(
            connection,
            "pending_email_verifications",
            {
                "email": "TEXT NOT NULL DEFAULT ''",
                "token": "TEXT NOT NULL DEFAULT ''",
                "draft_json": "TEXT NOT NULL DEFAULT '{}'",
                "expires_at": "TEXT NOT NULL DEFAULT ''",
                "verified_at": "TEXT NULL",
                "used_at": "TEXT NULL",
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )

    def _create_student_tables(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                learner_name TEXT NOT NULL,
                learner_age INTEGER NULL,
                owner_user_id INTEGER NOT NULL,
                class_level TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS student_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                relationship_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(student_id, user_id, relationship_type),
                FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        self._ensure_columns(
            connection,
            "students",
            {
                "learner_age": "INTEGER NULL",
                "owner_user_id": "INTEGER NOT NULL DEFAULT 0",
                "class_level": "TEXT NOT NULL DEFAULT ''",
                "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self._ensure_columns(
            connection,
            "student_links",
            {
                "relationship_type": "TEXT NOT NULL DEFAULT 'self'",
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )

    def _create_progress_table(self, connection: sqlite3.Connection) -> None:
        if self._table_exists(connection, "progress"):
            columns = self._table_columns(connection, "progress")
            if "student_id" in columns:
                self._ensure_columns(
                    connection,
                    "progress",
                    {
                        "points": "INTEGER NOT NULL DEFAULT 0",
                        "streak": "INTEGER NOT NULL DEFAULT 0",
                        "study_minutes": "INTEGER NOT NULL DEFAULT 0",
                        "quizzes_completed": "INTEGER NOT NULL DEFAULT 0",
                        "daily_points_json": "TEXT NOT NULL DEFAULT '{}'",
                        "daily_minutes_json": "TEXT NOT NULL DEFAULT '{}'",
                        "badges_json": "TEXT NOT NULL DEFAULT '[]'",
                        "updated_at": "TEXT NOT NULL DEFAULT ''",
                    },
                )
                return
            connection.execute("ALTER TABLE progress RENAME TO progress_user_legacy")

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS progress (
                student_id INTEGER PRIMARY KEY,
                points INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0,
                study_minutes INTEGER NOT NULL DEFAULT 0,
                quizzes_completed INTEGER NOT NULL DEFAULT 0,
                daily_points_json TEXT NOT NULL DEFAULT '{}',
                daily_minutes_json TEXT NOT NULL DEFAULT '{}',
                badges_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
            )
            """
        )

        if self._table_exists(connection, "progress_user_legacy"):
            rows = connection.execute(
                """
                SELECT user_id, points, streak, study_minutes, quizzes_completed, updated_at
                FROM progress_user_legacy
                """
            ).fetchall()
            for row in rows:
                student_id = self.ensure_self_student(
                    connection,
                    user_id=row["user_id"],
                    learner_name="",
                    learner_age=None,
                )
                connection.execute(
                    """
                    INSERT OR REPLACE INTO progress (
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
                    """,
                    (
                        student_id,
                        row["points"],
                        row["streak"],
                        row["study_minutes"],
                        row["quizzes_completed"],
                        "{}",
                        "{}",
                        "[]",
                        row["updated_at"] or utc_now(),
                    ),
                )
            connection.execute("DROP TABLE progress_user_legacy")

    def _create_assignment_tables(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_user_id INTEGER NOT NULL,
                owner_user_id INTEGER NULL,
                assignment_type TEXT NOT NULL DEFAULT 'mentor_assigned',
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                due_date TEXT NULL,
                class_id INTEGER NULL,
                priority TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(teacher_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assignment_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                assignment_id INTEGER NOT NULL,
                student_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'assigned',
                created_at TEXT NOT NULL,
                seen_at TEXT NULL,
                completed_at TEXT NULL,
                UNIQUE(assignment_id, student_id),
                FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
                FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
            )
            """
        )
        self._ensure_columns(
            connection,
            "assignments",
            {
                "owner_user_id": "INTEGER NULL",
                "assignment_type": "TEXT NOT NULL DEFAULT 'mentor_assigned'",
                "description": "TEXT NOT NULL DEFAULT ''",
                "due_date": "TEXT NULL",
                "class_id": "INTEGER NULL",
                "priority": "TEXT NOT NULL DEFAULT ''",
                "created_at": "TEXT NOT NULL DEFAULT ''",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self._ensure_columns(
            connection,
            "assignment_targets",
            {
                "status": "TEXT NOT NULL DEFAULT 'assigned'",
                "created_at": "TEXT NOT NULL DEFAULT ''",
                "seen_at": "TEXT NULL",
                "completed_at": "TEXT NULL",
                "marks_obtained": "REAL NULL",
                "max_marks": "REAL NULL",
                "feedback": "TEXT NULL",
                "graded_at": "TEXT NULL",
            },
        )

    def _create_class_tables(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS classes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mentor_user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                grade_level TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                schedule TEXT NOT NULL DEFAULT '',
                academic_year TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(mentor_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS student_class_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id INTEGER NOT NULL,
                student_id INTEGER NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
                FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
            )
            """
        )
        self._ensure_columns(
            connection,
            "classes",
            {
                "grade_level": "TEXT NOT NULL DEFAULT ''",
                "subject": "TEXT NOT NULL DEFAULT ''",
                "description": "TEXT NOT NULL DEFAULT ''",
                "schedule": "TEXT NOT NULL DEFAULT ''",
                "academic_year": "TEXT NOT NULL DEFAULT ''",
                "created_at": "TEXT NOT NULL DEFAULT ''",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self._ensure_columns(
            connection,
            "student_class_links",
            {
                "created_at": "TEXT NOT NULL DEFAULT ''",
            },
        )

    def _ensure_columns(self, connection: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
        existing = self._table_columns(connection, table)
        for column, ddl in columns.items():
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    def _table_exists(self, connection: sqlite3.Connection, table: str) -> bool:
        row = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
            (table,),
        ).fetchone()
        return bool(row)

    def _table_columns(self, connection: sqlite3.Connection, table: str) -> set[str]:
        if not self._table_exists(connection, table):
            return set()
        return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}

    def _migrate_legacy_progress(self, connection: sqlite3.Connection) -> None:
        table_rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        for row in table_rows:
            table_name = row["name"]
            if table_name in {
                "users",
                "profiles",
                "students",
                "student_links",
                "progress",
                "progress_user_legacy",
                "verification_tokens",
                "classes",
                "student_class_links",
                "assignments",
                "assignment_targets",
                "sqlite_sequence",
            }:
                continue
            columns = self._table_columns(connection, table_name)
            if {"user", "stats_json", "updated_at"}.issubset(columns):
                legacy_rows = connection.execute(
                    f"SELECT user, stats_json, updated_at FROM {table_name}"
                ).fetchall()
                for legacy_row in legacy_rows:
                    self._upsert_legacy_row(
                        connection,
                        legacy_user=legacy_row["user"],
                        stats_json=legacy_row["stats_json"],
                        updated_at=legacy_row["updated_at"],
                    )

    def _upsert_legacy_row(
        self,
        connection: sqlite3.Connection,
        legacy_user: str,
        stats_json: str | None,
        updated_at: str | None,
    ) -> None:
        email = legacy_user if legacy_user and "@" in legacy_user else f"{legacy_user or 'legacy'}@legacy.prepbro.local"
        existing_user = connection.execute(
            "SELECT id FROM users WHERE email = ?",
            (email.lower(),),
        ).fetchone()
        if existing_user:
            user_id = existing_user["id"]
        else:
            connection.execute(
                """
                INSERT INTO users (email, password_hash, role, is_verified, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (email.lower(), f"legacy-disabled-{secrets.token_urlsafe(12)}", "student", 1, updated_at or utc_now()),
            )
            user_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            connection.execute(
                """
                INSERT OR IGNORE INTO profiles (user_id, display_name, age, learning_goal, preferences_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_id, legacy_user or "Legacy User", None, "", "{}"),
            )

        stats = _safe_json_loads(stats_json, {})
        student_id = self.ensure_self_student(
            connection,
            user_id=user_id,
            learner_name=legacy_user or "Legacy Learner",
            learner_age=None,
        )
        connection.execute(
            """
            INSERT OR REPLACE INTO progress (
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
            """,
            (
                student_id,
                int(stats.get("points", 0) or 0),
                int(stats.get("streak", 0) or 0),
                int(stats.get("study_minutes", stats.get("totalMinutes", 0)) or 0),
                int(stats.get("quizzes_completed", stats.get("quizzesCompleted", 0)) or 0),
                json.dumps(stats.get("dailyPoints", {}) or {}),
                json.dumps(stats.get("dailyMinutes", {}) or {}),
                json.dumps(stats.get("badges", []) or []),
                updated_at or utc_now(),
            ),
        )

    def _backfill_student_records(self, connection: sqlite3.Connection) -> None:
        users = connection.execute(
            """
            SELECT
                u.id,
                u.email,
                u.role,
                p.display_name,
                p.age
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            """
        ).fetchall()
        for user in users:
            if (user["role"] or "student") == "student":
                self.ensure_self_student(
                    connection,
                    user_id=user["id"],
                    learner_name=user["display_name"] or user["email"],
                    learner_age=user["age"],
                )

    def ensure_self_student(
        self,
        connection: sqlite3.Connection,
        *,
        user_id: int,
        learner_name: str,
        learner_age: int | None,
    ) -> int:
        existing = connection.execute(
            """
            SELECT s.id
            FROM students s
            INNER JOIN student_links sl ON sl.student_id = s.id
            WHERE sl.user_id = ? AND sl.relationship_type = 'self'
            ORDER BY s.id ASC
            LIMIT 1
            """,
            (user_id,),
        ).fetchone()
        if existing:
            student_id = existing["id"]
            connection.execute(
                """
                UPDATE students
                SET learner_name = COALESCE(NULLIF(?, ''), learner_name),
                    learner_age = COALESCE(?, learner_age)
                WHERE id = ?
                """,
                (learner_name, learner_age, student_id),
            )
            return student_id

        created_at = utc_now()
        row = connection.execute(
            """
            SELECT p.display_name, p.age, u.email
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.id = ?
            """,
            (user_id,),
        ).fetchone()
        fallback_name = learner_name or (row["display_name"] if row else "") or (row["email"] if row else "") or "Learner"
        fallback_age = learner_age if learner_age is not None else (row["age"] if row else None)
        connection.execute(
            """
            INSERT INTO students (learner_name, learner_age, owner_user_id, class_level, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (fallback_name, fallback_age, user_id, "", "{}", created_at),
        )
        student_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        connection.execute(
            """
            INSERT OR IGNORE INTO student_links (student_id, user_id, relationship_type, created_at)
            VALUES (?, ?, 'self', ?)
            """,
            (student_id, user_id, created_at),
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO progress (
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
            VALUES (?, 0, 0, 0, 0, '{}', '{}', '[]', ?)
            """,
            (student_id, created_at),
        )
        return student_id

    def create_managed_student(
        self,
        connection: sqlite3.Connection,
        *,
        owner_user_id: int,
        relationship_type: str,
        learner_name: str,
        learner_age: int | None,
        class_level: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = utc_now()
        connection.execute(
            """
            INSERT INTO students (learner_name, learner_age, owner_user_id, class_level, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                learner_name.strip() or "Learner",
                learner_age,
                owner_user_id,
                class_level.strip(),
                json.dumps(metadata or {}),
                created_at,
            ),
        )
        student_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO student_links (student_id, user_id, relationship_type, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (student_id, owner_user_id, relationship_type, created_at),
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
            VALUES (?, 0, 0, 0, 0, '{}', '{}', '[]', ?)
            """,
            (student_id, created_at),
        )
        return student_id

    def link_user_to_student(
        self,
        connection: sqlite3.Connection,
        *,
        student_id: int,
        user_id: int,
        relationship_type: str,
    ) -> None:
        connection.execute(
            """
            INSERT OR IGNORE INTO student_links (student_id, user_id, relationship_type, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (student_id, user_id, relationship_type, utc_now()),
        )

    def ensure_profile_record(
        self,
        connection: sqlite3.Connection,
        *,
        user_id: int,
        display_name: str = "",
        age: int | None = None,
        learning_goal: str = "",
        preferences_json: dict[str, Any] | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT OR IGNORE INTO profiles (user_id, display_name, age, learning_goal, preferences_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, display_name, age, learning_goal, json.dumps(preferences_json or {})),
        )

    def row_to_profile(self, row: sqlite3.Row) -> dict[str, Any]:
        preferences = _safe_json_loads(row["preferences_json"] if "preferences_json" in row.keys() else "{}", {})
        return {
            "user_id": row["user_id"],
            "email": row["email"],
            "role": row["role"],
            "display_name": row["display_name"] or "",
            "age": row["age"],
            "learning_goal": row["learning_goal"] or "",
            "preferences_json": preferences,
            "is_verified": bool(row["is_verified"]),
            "created_at": row["created_at"],
        }

    def row_to_progress(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "student_id": row["student_id"],
            "points": int(row["points"] or 0),
            "streak": int(row["streak"] or 0),
            "study_minutes": int(row["study_minutes"] or 0),
            "quizzes_completed": int(row["quizzes_completed"] or 0),
            "daily_points": _safe_json_loads(row["daily_points_json"], {}),
            "daily_minutes": _safe_json_loads(row["daily_minutes_json"], {}),
            "badges": _safe_json_loads(row["badges_json"], []),
            "updated_at": row["updated_at"],
        }

from __future__ import annotations

import json
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from app.config import Settings

try:
    import psycopg2
    import psycopg2.extras
except ImportError:  # pragma: no cover
    psycopg2 = None


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


def is_postgres_url(database_url: str) -> bool:
    lowered = (database_url or "").lower()
    return lowered.startswith("postgres://") or lowered.startswith("postgresql://")


def _safe_json_loads(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


class RowAdapter(dict):
    def keys(self):  # type: ignore[override]
        return super().keys()


class CursorAdapter:
    def __init__(self, fetchone_fn, fetchall_fn):
        self._fetchone_fn = fetchone_fn
        self._fetchall_fn = fetchall_fn

    def fetchone(self):
        return self._fetchone_fn()

    def fetchall(self):
        return self._fetchall_fn()


class PostgresConnectionAdapter:
    AUTO_ID_TABLES = {
        "users",
        "verification_tokens",
        "pending_email_verifications",
        "students",
        "student_links",
        "assignments",
        "assignment_targets",
        "classes",
        "student_class_links",
    }

    def __init__(self, raw_connection):
        self._connection = raw_connection
        self._last_insert_id: int | None = None

    def _convert_sql(self, sql: str) -> str:
        if "?" not in sql:
            return sql
        pieces = sql.split("?")
        return "%s".join(pieces)

    def _maybe_capture_insert_id(self, sql: str, params: tuple[Any, ...], cursor) -> None:
        stripped = sql.strip().rstrip(";")
        if not stripped.lower().startswith("insert into "):
            return
        if " returning " in stripped.lower():
            return
        table_match = re.match(r"insert\s+into\s+([a-zA-Z_][a-zA-Z0-9_]*)", stripped, re.IGNORECASE)
        if not table_match:
            return
        table = table_match.group(1)
        if table.lower() not in self.AUTO_ID_TABLES:
            cursor.execute(self._convert_sql(sql), params)
            return
        converted = self._convert_sql(f"{stripped} RETURNING id")
        cursor.execute(converted, params)
        row = cursor.fetchone()
        if row and "id" in row:
            self._last_insert_id = int(row["id"])

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        normalized_sql = sql.strip()

        if normalized_sql.lower() == "select last_insert_rowid() as id":
            row = RowAdapter({"id": self._last_insert_id or 0})
            return CursorAdapter(lambda: row, lambda: [row])

        cursor = self._connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        converted_sql = self._convert_sql(sql)
        lowered = normalized_sql.lower()

        if lowered.startswith("insert into "):
            self._maybe_capture_insert_id(sql, params, cursor)
        else:
            cursor.execute(converted_sql, params)

        def _wrap_one():
            value = cursor.fetchone()
            return RowAdapter(value) if value else None

        def _wrap_all():
            rows = cursor.fetchall()
            return [RowAdapter(row) for row in rows]

        return CursorAdapter(_wrap_one, _wrap_all)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        self._connection.close()


class Database:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.database_url = settings.database_url
        self.engine = "postgres" if is_postgres_url(settings.database_url) else "sqlite"
        self.path = resolve_sqlite_path(settings.database_url) if self.engine == "sqlite" else None

    @contextmanager
    def connect(self) -> Iterator[Any]:
        if self.engine == "sqlite":
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
            return

        if psycopg2 is None:
            raise RuntimeError("psycopg2-binary is required for PostgreSQL DATABASE_URL support.")
        parsed = urlparse(self.database_url)
        db_name = parsed.path.lstrip("/")
        raw_connection = psycopg2.connect(
            dbname=db_name,
            user=parsed.username,
            password=parsed.password,
            host=parsed.hostname,
            port=parsed.port or 5432,
            sslmode="require" if parsed.hostname and "localhost" not in parsed.hostname else "prefer",
        )
        connection = PostgresConnectionAdapter(raw_connection)
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

    def _id_column(self) -> str:
        return "SERIAL PRIMARY KEY" if self.engine == "postgres" else "INTEGER PRIMARY KEY AUTOINCREMENT"

    def _create_user_tables(self, connection: Any) -> None:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS users (
                id {self._id_column()},
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
            f"""
            CREATE TABLE IF NOT EXISTS verification_tokens (
                id {self._id_column()},
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
            f"""
            CREATE TABLE IF NOT EXISTS pending_email_verifications (
                id {self._id_column()},
                email TEXT NOT NULL,
                token TEXT NOT NULL UNIQUE,
                draft_json TEXT NOT NULL DEFAULT '{{}}',
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

    def _create_student_tables(self, connection: Any) -> None:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS students (
                id {self._id_column()},
                learner_name TEXT NOT NULL,
                learner_age INTEGER NULL,
                owner_user_id INTEGER NOT NULL,
                class_level TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{{}}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS student_links (
                id {self._id_column()},
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

    def _create_progress_table(self, connection: Any) -> None:
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
            if self.engine == "sqlite":
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

        if self.engine == "sqlite" and self._table_exists(connection, "progress_user_legacy"):
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
                self._upsert_progress_row(
                    connection,
                    student_id=student_id,
                    points=row["points"],
                    streak=row["streak"],
                    study_minutes=row["study_minutes"],
                    quizzes_completed=row["quizzes_completed"],
                    daily_points_json="{}",
                    daily_minutes_json="{}",
                    badges_json="[]",
                    updated_at=row["updated_at"] or utc_now(),
                )
            connection.execute("DROP TABLE progress_user_legacy")

    def _create_assignment_tables(self, connection: Any) -> None:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS assignments (
                id {self._id_column()},
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
            f"""
            CREATE TABLE IF NOT EXISTS assignment_targets (
                id {self._id_column()},
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

    def _create_class_tables(self, connection: Any) -> None:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS classes (
                id {self._id_column()},
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
            f"""
            CREATE TABLE IF NOT EXISTS student_class_links (
                id {self._id_column()},
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

    def _ensure_columns(self, connection: Any, table: str, columns: dict[str, str]) -> None:
        existing = self._table_columns(connection, table)
        for column, ddl in columns.items():
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    def _table_exists(self, connection: Any, table: str) -> bool:
        if self.engine == "sqlite":
            row = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                (table,),
            ).fetchone()
            return bool(row)
        row = connection.execute(
            """
            SELECT table_name AS name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ?
            """,
            (table,),
        ).fetchone()
        return bool(row)

    def _table_columns(self, connection: Any, table: str) -> set[str]:
        if not self._table_exists(connection, table):
            return set()
        if self.engine == "sqlite":
            return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        rows = connection.execute(
            """
            SELECT column_name AS name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ?
            """,
            (table,),
        ).fetchall()
        return {row["name"] for row in rows}

    def _migrate_legacy_progress(self, connection: Any) -> None:
        if self.engine != "sqlite":
            return
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
                "pending_email_verifications",
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

    def _insert_or_ignore_profile(
        self,
        connection: Any,
        *,
        user_id: int,
        display_name: str,
        age: int | None,
        learning_goal: str,
        preferences_json: dict[str, Any] | None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO profiles (user_id, display_name, age, learning_goal, preferences_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO NOTHING
            """,
            (user_id, display_name, age, learning_goal, json.dumps(preferences_json or {})),
        )

    def _insert_or_ignore_student_link(
        self,
        connection: Any,
        *,
        student_id: int,
        user_id: int,
        relationship_type: str,
        created_at: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO student_links (student_id, user_id, relationship_type, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(student_id, user_id, relationship_type) DO NOTHING
            """,
            (student_id, user_id, relationship_type, created_at),
        )

    def _upsert_progress_row(
        self,
        connection: Any,
        *,
        student_id: int,
        points: int,
        streak: int,
        study_minutes: int,
        quizzes_completed: int,
        daily_points_json: str,
        daily_minutes_json: str,
        badges_json: str,
        updated_at: str,
    ) -> None:
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
                points,
                streak,
                study_minutes,
                quizzes_completed,
                daily_points_json,
                daily_minutes_json,
                badges_json,
                updated_at,
            ),
        )

    def _upsert_legacy_row(
        self,
        connection: Any,
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
            self._insert_or_ignore_profile(
                connection,
                user_id=user_id,
                display_name=legacy_user or "Legacy User",
                age=None,
                learning_goal="",
                preferences_json={},
            )

        stats = _safe_json_loads(stats_json, {})
        student_id = self.ensure_self_student(
            connection,
            user_id=user_id,
            learner_name=legacy_user or "Legacy Learner",
            learner_age=None,
        )
        self._upsert_progress_row(
            connection,
            student_id=student_id,
            points=int(stats.get("points", 0) or 0),
            streak=int(stats.get("streak", 0) or 0),
            study_minutes=int(stats.get("study_minutes", stats.get("totalMinutes", 0)) or 0),
            quizzes_completed=int(stats.get("quizzes_completed", stats.get("quizzesCompleted", 0)) or 0),
            daily_points_json=json.dumps(stats.get("dailyPoints", {}) or {}),
            daily_minutes_json=json.dumps(stats.get("dailyMinutes", {}) or {}),
            badges_json=json.dumps(stats.get("badges", []) or []),
            updated_at=updated_at or utc_now(),
        )

    def _backfill_student_records(self, connection: Any) -> None:
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
        connection: Any,
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
        self._insert_or_ignore_student_link(
            connection,
            student_id=student_id,
            user_id=user_id,
            relationship_type="self",
            created_at=created_at,
        )
        self._upsert_progress_row(
            connection,
            student_id=student_id,
            points=0,
            streak=0,
            study_minutes=0,
            quizzes_completed=0,
            daily_points_json="{}",
            daily_minutes_json="{}",
            badges_json="[]",
            updated_at=created_at,
        )
        return student_id

    def create_managed_student(
        self,
        connection: Any,
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
        self._upsert_progress_row(
            connection,
            student_id=student_id,
            points=0,
            streak=0,
            study_minutes=0,
            quizzes_completed=0,
            daily_points_json="{}",
            daily_minutes_json="{}",
            badges_json="[]",
            updated_at=created_at,
        )
        return student_id

    def link_user_to_student(
        self,
        connection: Any,
        *,
        student_id: int,
        user_id: int,
        relationship_type: str,
    ) -> None:
        self._insert_or_ignore_student_link(
            connection,
            student_id=student_id,
            user_id=user_id,
            relationship_type=relationship_type,
            created_at=utc_now(),
        )

    def ensure_profile_record(
        self,
        connection: Any,
        *,
        user_id: int,
        display_name: str = "",
        age: int | None = None,
        learning_goal: str = "",
        preferences_json: dict[str, Any] | None = None,
    ) -> None:
        self._insert_or_ignore_profile(
            connection,
            user_id=user_id,
            display_name=display_name,
            age=age,
            learning_goal=learning_goal,
            preferences_json=preferences_json,
        )

    def row_to_profile(self, row: Any) -> dict[str, Any]:
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

    def row_to_progress(self, row: Any) -> dict[str, Any]:
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

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings
from app.db import Database

PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 8 characters and include uppercase, lowercase, and a number."
)
PASSWORD_TOO_LONG_MESSAGE = "Password is too long. Please use 72 bytes or fewer."

bearer_scheme = HTTPBearer(auto_error=False)


def _validate_password_length(password: str) -> None:
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail=PASSWORD_TOO_LONG_MESSAGE)


def validate_password(password: str) -> None:
    _validate_password_length(password)
    if len(password) < 8:
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)
    if not re.search(r"[A-Z]", password):
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)
    if not re.search(r"[a-z]", password):
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)
    if not re.search(r"\d", password):
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)


def hash_password(password: str) -> str:
    validate_password(password)
    password_bytes = password.encode("utf-8")
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password_bytes, salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    _validate_password_length(password)
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=PASSWORD_TOO_LONG_MESSAGE) from exc


def create_access_token(user_id: int, email: str, settings: Settings) -> tuple[str, str]:
    if not settings.jwt_secret:
        raise HTTPException(status_code=500, detail="JWT_SECRET is not configured.")
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": str(user_id),
        "email": email,
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    return token, expires_at.isoformat()


def decode_access_token(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.jwt_secret:
        raise HTTPException(status_code=500, detail="JWT_SECRET is not configured.")
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.") from exc


def build_current_user_dependency(database: Database, settings: Settings):
    def get_current_user(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    ) -> dict[str, Any]:
        if not credentials or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
        payload = decode_access_token(credentials.credentials, settings)
        user_id = int(payload["sub"])
        with database.connect() as connection:
            row = connection.execute(
                """
                SELECT u.id, u.email, u.role, u.is_verified, u.created_at
                FROM users u
                WHERE u.id = ?
                """,
                (user_id,),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found.")
            return {
                "id": row["id"],
                "email": row["email"],
                "role": row["role"],
                "is_verified": bool(row["is_verified"]),
                "created_at": row["created_at"],
            }

    return get_current_user

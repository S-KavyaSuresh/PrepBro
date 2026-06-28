from __future__ import annotations

import os
from dataclasses import dataclass


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass
class Settings:
    app_name: str
    app_env: str
    database_url: str
    demo_verification_fallback: bool
    jwt_secret: str
    jwt_expire_minutes: int
    frontend_url: str
    backend_url: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_from: str
    smtp_tls: bool

    @property
    def cors_origins(self) -> list[str]:
        if self.app_env.lower() == "production":
            return [self.frontend_url] if self.frontend_url else []
        return [
            "http://localhost:5173",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:3000",
            *(
                _split_csv(os.getenv("CORS_ORIGINS", ""))
                if os.getenv("CORS_ORIGINS")
                else []
            ),
        ]

    @property
    def smtp_configured(self) -> bool:
        return bool(
            self.smtp_host and self.smtp_port and self.smtp_user and self.smtp_password and self.smtp_from
        )


def get_settings() -> Settings:
    return Settings(
        app_name=os.getenv("APP_NAME", "PrepBro API"),
        app_env=os.getenv("APP_ENV", "development"),
        database_url=os.getenv("DATABASE_URL", "sqlite:///./prepbro.db"),
        demo_verification_fallback=os.getenv("DEMO_VERIFICATION_FALLBACK", "false").lower() in {"1", "true", "yes", "on"},
        jwt_secret=os.getenv("JWT_SECRET", ""),
        jwt_expire_minutes=int(os.getenv("JWT_EXPIRE_MINUTES", "120")),
        frontend_url=os.getenv("FRONTEND_URL", "http://localhost:5173"),
        backend_url=os.getenv("BACKEND_URL", "http://localhost:8000"),
        smtp_host=os.getenv("SMTP_HOST", ""),
        smtp_port=int(os.getenv("SMTP_PORT", "587")),
        smtp_user=os.getenv("SMTP_USER", ""),
        smtp_password=os.getenv("SMTP_PASSWORD", "").replace(" ", "").strip(),
        smtp_from=os.getenv("SMTP_FROM", ""),
        smtp_tls=os.getenv("SMTP_TLS", "true").lower() not in {"0", "false", "no"},
    )

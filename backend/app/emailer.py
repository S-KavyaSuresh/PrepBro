from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from app.config import Settings

logger = logging.getLogger(__name__)


def send_verification_email(
    *,
    settings: Settings,
    email: str,
    token: str,
    verify_url: str,
) -> dict:
    if not settings.smtp_configured:
        if settings.app_env.lower() != "production":
            logger.info("PrepBro verification preview for %s: %s", email, verify_url)
        return {
            "sent": False,
            "reason": "SMTP not configured",
            "preview_token": token,
            "preview_verify_url": verify_url,
        }

    message = EmailMessage()
    message["Subject"] = "Verify your PrepBro account"
    message["From"] = settings.smtp_from
    message["To"] = email
    message.set_content(
        "\n".join(
            [
                "Welcome to PrepBro!",
                "",
                "Use the link below to verify this account:",
                verify_url,
            ]
        )
    )
    message.add_alternative(
        f"""
        <html>
          <body style="font-family: Arial, sans-serif; color: #1f2a44; line-height: 1.6;">
            <h2 style="margin-bottom: 8px;">Welcome to PrepBro!</h2>
            <p>Please verify your email address to finish setting up your account.</p>
            <p>
              <a
                href="{verify_url}"
                style="display:inline-block;padding:12px 18px;border-radius:999px;background:#3f5efb;color:#ffffff;text-decoration:none;font-weight:700;"
              >
                Verify Email
              </a>
            </p>
            <p>If the button does not work, copy and paste this link into your browser:</p>
            <p>{verify_url}</p>
          </body>
        </html>
        """,
        subtype="html",
    )

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as server:
            if settings.smtp_tls:
                server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
    except Exception as exc:  # pragma: no cover - defensive email transport handling
        logger.warning("PrepBro verification email failed for %s: %s", email, exc.__class__.__name__)
        return {
            "sent": False,
            "reason": "Verification email could not be sent right now.",
        }

    logger.info("PrepBro verification email sent to %s", email)
    if settings.app_env.lower() != "production":
        return {
            "sent": True,
            "preview_token": token,
            "preview_verify_url": verify_url,
        }
    return {"sent": True}

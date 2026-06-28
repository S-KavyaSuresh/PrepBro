from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import httpx


# ── JSON helpers ─────────────────────────────────────────────────────────────

def safe_json_loads(text: str) -> Dict[str, Any]:
    raw = (text or "").strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
    if raw.endswith("```"):
        raw = raw[:-3]
    raw = raw.strip()
    return json.loads(raw)


def extract_image_data_url_from_chat(completion: Dict[str, Any]) -> Optional[str]:
    try:
        choices = completion.get("choices") or []
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url")
                    if isinstance(url, str) and url:
                        return url
        return None
    except Exception:
        return None


# ── Groq Client ───────────────────────────────────────────────────────────────

GROQ_BASE = "https://api.groq.com/openai/v1"

# Best Groq models for our use case:
# llama-3.3-70b-versatile  — very fast, excellent instruction following, great JSON
# llama3-8b-8192           — fastest, good for short tasks
TEXT_MODEL   = "llama-3.3-70b-versatile"
VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"  # Groq vision model


class GroqClient:
    def __init__(self, api_key: str, timeout_s: float = 60.0):
        self.api_key   = api_key
        self.timeout_s = timeout_s
        self.text_model   = TEXT_MODEL
        self.vision_model = VISION_MODEL

    @staticmethod
    def from_env() -> "GroqClient":
        key = os.getenv("GROQ_API_KEY", "").strip()
        return GroqClient(api_key=key)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type":  "application/json",
        }

    async def _post(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.api_key:
            raise RuntimeError("GROQ_API_KEY not set in .env")
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(
                f"{GROQ_BASE}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"Groq error {resp.status_code}: {resp.text[:400]}")
            return resp.json()

    def _extract_content(self, data: Dict[str, Any]) -> str:
        return (
            ((data.get("choices") or [])[0] or {})
            .get("message", {})
            .get("content", "") or ""
        )

    async def chat_text(
        self,
        *,
        system: str,
        user: str,
        response_format_json: bool = False,
    ) -> str:
        body: Dict[str, Any] = {
            "model": self.text_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "temperature": 0.3,
            "max_tokens":  8000,  # Increased from 4096 to prevent truncation
        }
        if response_format_json:
            body["response_format"] = {"type": "json_object"}

        data = await self._post(body)
        return self._extract_content(data)

    async def chat_vision(
        self,
        *,
        system: str,
        user: str,
        images: List[str] | None = None,
    ) -> str:
        content_parts: List[Dict[str, Any]] = [{"type": "text", "text": user}]
        if images:
            for img_url in images:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": img_url},
                })
        body: Dict[str, Any] = {
            "model": self.vision_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": content_parts},
            ],
            "temperature": 0.3,
            "max_tokens":  4096,
        }
        data = await self._post(body)
        return self._extract_content(data)

    # Keep this for API compatibility with main.py references
    async def chat_image_gen(self, *, prompt: str) -> Dict[str, Any]:
        return {}


# ── Backward-compatible alias ─────────────────────────────────────────────────
# main.py creates:  ai = OpenRouterClient.from_env()
# We alias it so no other file needs to change.
class OpenRouterClient(GroqClient):
    @staticmethod
    def from_env() -> "OpenRouterClient":  # type: ignore[override]
        key = os.getenv("GROQ_API_KEY", "").strip()
        if not key:
            # Fall back to old key name in case user has old .env
            key = os.getenv("OPENROUTER_TEXT_API_KEY", "").strip()
        client = OpenRouterClient(api_key=key)
        return client

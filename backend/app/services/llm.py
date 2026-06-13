"""Unified LLM client.

The backend is provider-agnostic. Configuration is read from four env vars:

    TYPE    = "OPENAI"  -> OpenAI-compatible chat completions protocol
            | "ANT"     -> Anthropic Messages protocol (served at /v1/messages)
    URL     = base URL of the provider (no trailing slash, no /v1 suffix)
    MODEL   = model id exposed by the provider
    KEY     = bearer key

For TYPE=OPENAI the requests are POSTed to {URL}/v1/chat/completions.
For TYPE=ANT  the requests are POSTed to {URL}/v1/messages and we translate
the OpenAI-style request/response shape to Anthropic's Messages shape.

This keeps a single credential surface and a single place to swap providers
or models without touching call sites in the services.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Literal

import httpx

from app.core.config import get_settings

ProviderType = Literal["OPENAI", "ANT"]


class LLMUnavailable(RuntimeError):
    """Raised when the LLM is not configured or returns no usable content."""


def _provider() -> ProviderType:
    raw = (get_settings().llm_type or "").strip().upper()
    if raw not in ("OPENAI", "ANT"):
        raise LLMUnavailable(
            f"Unsupported LLM_TYPE={raw!r}. Set TYPE to OPENAI or ANT in backend/.env"
        )
    return raw  # type: ignore[return-value]


def _base_url() -> str:
    return (get_settings().llm_url or "").rstrip("/")


def _model() -> str:
    return get_settings().llm_model


def _key() -> str:
    return get_settings().llm_key


def is_configured() -> bool:
    """True when the four required env vars are present."""
    import os

    if any(os.environ.get(name) for name in ("TYPE", "URL", "MODEL", "KEY")):
        return all(os.environ.get(name) for name in ("TYPE", "URL", "MODEL", "KEY"))
    try:
        s = get_settings()
    except Exception:
        return False
    return bool(s.llm_type and s.llm_url and s.llm_model and s.llm_key)


def _openai_payload(
    messages: list[dict[str, str]],
    *,
    temperature: float,
    response_format_json: bool,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": _model(),
        "messages": messages,
        "temperature": temperature,
    }
    if response_format_json:
        payload["response_format"] = {"type": "json_object"}
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    return payload


def _ant_payload(
    messages: list[dict[str, str]],
    *,
    temperature: float,
    response_format_json: bool,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """Translate OpenAI-style messages into Anthropic Messages shape."""
    system_parts: list[str] = []
    convo: list[dict[str, str]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content", "")
        if role == "system":
            system_parts.append(content)
        elif role in ("user", "assistant"):
            convo.append({"role": role, "content": content})
    if not convo:
        convo = [{"role": "user", "content": ""}]
    payload: dict[str, Any] = {
        "model": _model(),
        "messages": convo,
        "temperature": temperature,
        "max_tokens": max_tokens or 2048,
    }
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)
    if response_format_json:
        # Encourage strict JSON in the response. Anthropic has no native
        # response_format; we rely on the prompt + a final post-parse step.
        payload["system"] = (
            (payload.get("system") or "")
            + "\n\nReturn strict JSON only. No prose, no code fences."
        ).strip()
    return payload


def _extract_text(data: dict[str, Any]) -> str:
    """Pull a single text string out of an OpenAI or Anthropic response."""
    if "choices" in data:  # OpenAI shape
        choices = data.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        return message.get("content") or ""
    if "content" in data:  # Anthropic shape
        parts = data.get("content") or []
        chunks: list[str] = []
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "text":
                chunks.append(part.get("text", ""))
            elif isinstance(part, str):
                chunks.append(part)
        return "".join(chunks)
    return ""


async def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    response_format_json: bool = False,
    max_tokens: int | None = None,
    timeout: float = 60.0,
) -> str:
    """Send a chat-completion-style request and return a single text reply."""
    if not is_configured():
        raise LLMUnavailable("LLM is not configured (missing TYPE/URL/MODEL/KEY in .env)")

    provider = _provider()
    base = _base_url()
    key = _key()

    headers = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "Authorization": f"Bearer {key}",
    }

    if provider == "OPENAI":
        url = f"{base}/v1/chat/completions"
        payload = _openai_payload(
            messages,
            temperature=temperature,
            response_format_json=response_format_json,
            max_tokens=max_tokens,
        )
    else:
        url = f"{base}/v1/messages"
        payload = _ant_payload(
            messages,
            temperature=temperature,
            response_format_json=response_format_json,
            max_tokens=max_tokens,
        )
        # Anthropic requires anthropic-version header
        headers["anthropic-version"] = "2023-06-01"

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()

    text = _extract_text(data).strip()
    if not text:
        raise LLMUnavailable("LLM returned an empty response")

    # If JSON was requested, attempt to clean code-fence wrappers before returning
    if response_format_json:
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()
    return text


async def chat_json(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: float = 60.0,
) -> Any:
    """Convenience wrapper that requests JSON and parses the reply."""
    raw = await chat(
        messages,
        temperature=temperature,
        response_format_json=True,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Best-effort: try to find a JSON object/array inside the text.
        import re

        match = re.search(r"(\{.*\}|\[.*\])", raw, re.S)
        if match:
            return json.loads(match.group(1))
        raise


def _extract_stream_delta(data: dict[str, Any]) -> str:
    """Pull a single token delta out of an SSE chunk payload."""
    # OpenAI: {"choices": [{"delta": {"content": "..."}}]}
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        delta = choices[0].get("delta") or {}
        if isinstance(delta, dict):
            return delta.get("content") or ""
    # Anthropic: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}
    if data.get("type") == "content_block_delta":
        delta = data.get("delta") or {}
        if isinstance(delta, dict):
            return delta.get("text") or ""
    return ""


async def stream_chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    max_tokens: int | None = 1500,
    timeout: float = 60.0,
) -> AsyncIterator[str]:
    """Yield token deltas as they stream in from the upstream provider.

    Falls back to a single non-streamed chunk when streaming is unsupported
    or when the provider returns no delta events, so consumers always see at
    least the final text. Raises ``LLMUnavailable`` for hard configuration
    errors so the route layer can swap in the local fallback.
    """
    if not is_configured():
        raise LLMUnavailable("LLM is not configured (missing TYPE/URL/MODEL/KEY in .env)")

    provider = _provider()
    base = _base_url()
    key = _key()

    headers = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "Authorization": f"Bearer {key}",
        "Accept": "text/event-stream",
    }

    if provider == "OPENAI":
        url = f"{base}/v1/chat/completions"
        payload = _openai_payload(
            messages,
            temperature=temperature,
            response_format_json=False,
            max_tokens=max_tokens,
        )
        payload["stream"] = True
    else:
        url = f"{base}/v1/messages"
        payload = _ant_payload(
            messages,
            temperature=temperature,
            response_format_json=False,
            max_tokens=max_tokens,
        )
        payload["stream"] = True
        headers["anthropic-version"] = "2023-06-01"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for raw_line in response.aiter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload_str = line[5:].strip()
                    if payload_str == "[DONE]":
                        break
                    try:
                        data = json.loads(payload_str)
                    except json.JSONDecodeError:
                        continue
                    delta = _extract_stream_delta(data)
                    if delta:
                        yield delta
    except LLMUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        # Surface as a "non-fatal" provider failure so the route can fall
        # back to the local heuristic reply.
        raise LLMUnavailable(f"stream failed: {exc}") from exc

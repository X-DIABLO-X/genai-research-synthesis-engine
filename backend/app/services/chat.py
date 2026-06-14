from typing import AsyncIterator

from sqlalchemy.orm import Session

from app.models import Brief, Project
from app.services import llm


def _brief_context(brief: Brief) -> str:
    sections: list[str] = []
    for section in brief.sections:
        summary = section.get("summary", "")
        claims = "\n".join(
            f"- {claim['text']} | excerpt: {claim.get('support_excerpt', '')} | citations: {', '.join(claim.get('citations', []))}"
            for claim in section.get("claims", [])
        )
        sections.append(f"{section['theme']} ({section['consensus_status']}):\nsummary: {summary}\n{claims}")
    citations = "\n".join(
        f"{key}: {value.get('paper_title', 'Unknown')} | {value.get('section', 'Unknown')} | page {value.get('page', 'n/a')} | excerpt: {value.get('support_excerpt', '')}"
        for key, value in brief.citation_map.items()
        if not str(key).startswith("__")
    )
    meta = brief.citation_map.get("__meta", {})
    section_text = "\n\n".join(sections)
    return (
        f"Executive summary:\n{brief.executive_summary}\n\n"
        f"Sections:\n{section_text}\n\n"
        f"Citation map:\n{citations}\n\n"
        f"Open questions:\n{meta.get('open_questions', [])}\n\n"
        f"Recommended papers:\n{meta.get('recommended_papers', [])}\n\n"
        f"Knowledge graph:\n{meta.get('knowledge_graph', {})}"
    )


def _local_chat_fallback(brief: Brief, prompt: str) -> str:
    lowered = prompt.lower()
    picked: list[str] = []
    for section in brief.sections:
        for claim in section.get("claims", []):
            haystack = f"{section['theme']} {claim['text']}".lower()
            if any(term in haystack for term in lowered.split() if len(term) > 3):
                refs = " ".join(claim.get("citations", []))
                picked.append(f"- {claim['text']} ({refs})")
            if len(picked) >= 3:
                break
        if len(picked) >= 3:
            break
    if not picked:
        picked = [
            f"- {claim['text']} ({' '.join(claim.get('citations', []))})"
            for section in brief.sections[:2]
            for claim in section.get("claims", [])[:2]
        ][:3]
    return "Here are the strongest cited points I can ground from the current brief:\n\n" + "\n".join(picked)


async def generate_chat_reply(db: Session, project_id: int, messages: list[dict]) -> str:
    project = db.get(Project, project_id)
    brief = (
        db.query(Brief)
        .filter(Brief.project_id == project_id)
        .order_by(Brief.created_at.desc())
        .first()
    )
    if not project or not brief:
        return "I do not have a synthesized brief yet. Finish the research run first, then I can answer from the cited result."

    latest_user_message = next((message.get("content", "") for message in reversed(messages) if message.get("role") == "user"), "")

    if not llm.is_configured():
        return _local_chat_fallback(brief, latest_user_message)

    transcript = "\n".join(f"{message.get('role', 'user')}: {message.get('content', '')}" for message in messages[-10:])
    system = (
        "You are a research synthesis assistant. Answer only from the supplied cited brief context. "
        "Do not invent papers, sections, or claims. When making factual statements, cite the bracket ids exactly as they appear in the context. "
        "Prefer specific findings over generic offers to help. If the evidence is weak or off-topic, say that directly and cite why. "
        "Respond in polished Markdown with short sections or bullets when helpful."
    )
    user = (
        f"Research question:\n{project.question}\n\n"
        f"Brief context:\n{_brief_context(brief)}\n\n"
        f"Conversation transcript:\n{transcript}\n\n"
        "Answer the latest user message. For broad questions such as 'what did you find out?', use a compact markdown structure with a short takeaway, "
        "3-6 evidence bullets with citations on every factual bullet, and a short evidence-limit note if needed. Do not answer with a generic capability statement."
    )
    try:
        return await llm.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            max_tokens=1500,
            timeout=18.0,
        )
    except llm.LLMUnavailable:
        return _local_chat_fallback(brief, latest_user_message)
    except Exception:
        return _local_chat_fallback(brief, latest_user_message)


def _render_attachments_block(attachments: list[dict] | None) -> str:
    """Format attached file excerpts as a context block for the prompt."""
    if not attachments:
        return ""
    parts: list[str] = []
    for item in attachments:
        filename = (item or {}).get("filename", "attached.txt")
        text = (item or {}).get("text", "")
        if not text:
            continue
        parts.append(f"--- {filename} ---\n{text}")
    return "\n\n".join(parts)


async def stream_chat_reply(
    db: Session,
    project_id: int,
    messages: list[dict],
    attachments: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Stream a chat reply token-by-token.

    Yields raw text deltas. If the LLM is not configured, falls back to
    streaming the local heuristic reply one character at a time so the
    UI can show a streaming animation even without a provider.
    """
    project = db.get(Project, project_id)
    brief = (
        db.query(Brief)
        .filter(Brief.project_id == project_id)
        .order_by(Brief.created_at.desc())
        .first()
    )
    if not project or not brief:
        yield "I do not have a synthesized brief yet. Finish the research run first, then I can answer from the cited result."
        return

    latest_user_message = next(
        (message.get("content", "") for message in reversed(messages) if message.get("role") == "user"),
        "",
    )

    if not llm.is_configured():
        for chunk in _chunked_stream(_local_chat_fallback(brief, latest_user_message), size=8):
            yield chunk
        return

    transcript = "\n".join(f"{message.get('role', 'user')}: {message.get('content', '')}" for message in messages[-10:])
    system = (
        "You are a research synthesis assistant. Answer only from the supplied cited brief context. "
        "Do not invent papers, sections, or claims. When making factual statements, cite the bracket ids exactly as they appear in the context. "
        "Prefer specific findings over generic offers to help. If the evidence is weak or off-topic, say that directly and cite why. "
        "Respond in polished Markdown with short sections or bullets when helpful."
    )
    attachment_block = _render_attachments_block(attachments)
    user = (
        f"Research question:\n{project.question}\n\n"
        f"Brief context:\n{_brief_context(brief)}\n\n"
        + (f"User-supplied excerpts:\n{attachment_block}\n\n" if attachment_block else "")
        + f"Conversation transcript:\n{transcript}\n\n"
        "Answer the latest user message. For broad questions such as 'what did you find out?', use a compact markdown structure with a short takeaway, "
        "3-6 evidence bullets with citations on every factual bullet, and a short evidence-limit note if needed. Do not answer with a generic capability statement."
    )
    try:
        async for delta in llm.stream_chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            max_tokens=1500,
            timeout=20.0,
        ):
            yield delta
    except llm.LLMUnavailable:
        # Provider failed mid-stream; fall through to a single local
        # chunk so the UI still gets an answer.
        yield _local_chat_fallback(brief, latest_user_message)
    except Exception:
        yield _local_chat_fallback(brief, latest_user_message)


def _chunked_stream(text: str, *, size: int = 8) -> list[str]:
    """Slice a static string into evenly-sized chunks for fake streaming."""
    return [text[i : i + size] for i in range(0, len(text), size)] or [text]

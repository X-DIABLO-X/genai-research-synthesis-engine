from functools import lru_cache
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AI Research Synthesis Engine"
    database_url: str = "sqlite:///./research_synthesis.db"
    upload_dir: Path = Path("storage/uploads")
    semantic_scholar_api_key: str | None = Field(default=None, alias="SEMANTIC_SCHOLAR_API_KEY")

    # ── Unified LLM configuration ─────────────────────────────────────────
    # TYPE  : OPENAI (OpenAI-compatible /v1/chat/completions)
    #         ANT    (Anthropic-compatible /v1/messages)
    # URL   : base URL of the provider (no trailing slash, no /v1 suffix)
    # MODEL : model id as exposed by the provider
    # KEY   : bearer key / api key
    llm_type: str = Field(default="", alias="TYPE")
    llm_url: str = Field(default="", alias="URL")
    llm_model: str = Field(default="", alias="MODEL")
    llm_key: str = Field(default="", alias="KEY")
    # ──────────────────────────────────────────────────────────────────────

    grobid_url: str = "http://localhost:8070"
    cors_origins: list[str] = ["*"]

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", populate_by_name=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()  # type: ignore[call-arg]
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    return settings

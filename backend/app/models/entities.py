from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(240), default="Untitled review")
    question: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    papers: Mapped[list["Paper"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    briefs: Mapped[list["Brief"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Paper(Base):
    __tablename__ = "papers"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(Text)
    authors: Mapped[list[dict]] = mapped_column(JSON, default=list)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    venue: Mapped[str | None] = mapped_column(String(240), nullable=True)
    doi: Mapped[str | None] = mapped_column(String(240), nullable=True)
    arxiv_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    semantic_scholar_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    abstract: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_provider: Mapped[str] = mapped_column(String(80), default="upload")
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    citation_count: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped["Project"] = relationship(back_populates="papers")
    documents: Mapped[list["Document"]] = relationship(back_populates="paper", cascade="all, delete-orphan")
    passages: Mapped[list["Passage"]] = relationship(back_populates="paper", cascade="all, delete-orphan")
    claims: Mapped[list["Claim"]] = relationship(back_populates="paper", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    filename: Mapped[str] = mapped_column(String(400))
    storage_path: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(80), default="uploaded")
    parsed_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    parsed_tei: Mapped[str | None] = mapped_column(Text, nullable=True)
    section_spans: Mapped[list[dict]] = mapped_column(JSON, default=list)
    page_map: Mapped[list[dict]] = mapped_column(JSON, default=list)

    paper: Mapped["Paper"] = relationship(back_populates="documents")


class Passage(Base):
    __tablename__ = "passages"

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"), nullable=True)
    section: Mapped[str] = mapped_column(String(240), default="Unknown")
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_unknown: Mapped[bool] = mapped_column(default=True)
    text: Mapped[str] = mapped_column(Text)
    char_start: Mapped[int] = mapped_column(Integer, default=0)
    char_end: Mapped[int] = mapped_column(Integer, default=0)
    embedding: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)

    paper: Mapped["Paper"] = relationship(back_populates="passages")


class Claim(Base):
    __tablename__ = "claims"

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    passage_id: Mapped[int] = mapped_column(ForeignKey("passages.id"), index=True)
    claim_text: Mapped[str] = mapped_column(Text)
    claim_type: Mapped[str] = mapped_column(String(40))
    support_excerpt: Mapped[str] = mapped_column(Text)
    section: Mapped[str] = mapped_column(String(240))
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.6)

    paper: Mapped["Paper"] = relationship(back_populates="claims")
    passage: Mapped["Passage"] = relationship()


class SynthesisGroup(Base):
    __tablename__ = "synthesis_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    theme: Mapped[str] = mapped_column(String(240))
    consensus_status: Mapped[str] = mapped_column(String(40))
    claim_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    rationale: Mapped[str] = mapped_column(Text, default="")


class Brief(Base):
    __tablename__ = "briefs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    executive_summary: Mapped[str] = mapped_column(Text)
    sections: Mapped[list[dict]] = mapped_column(JSON, default=list)
    citation_map: Mapped[dict] = mapped_column(JSON, default=dict)
    validation_errors: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped["Project"] = relationship(back_populates="briefs")

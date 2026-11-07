-- pgvector must exist before any vector column is created (spec §3).
CREATE EXTENSION IF NOT EXISTS vector;

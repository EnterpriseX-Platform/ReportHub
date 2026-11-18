-- Built-in Document capability: page-layout documents (sections of headings, paragraphs,
-- tables, images) authored in the Documents editor and exported to PDF by the document exporter.
--
-- V80 leaves a gap after the core migrations so concurrently developed features can claim the
-- versions in between without clashing.
CREATE TABLE IF NOT EXISTS document (
    id          BIGSERIAL PRIMARY KEY,
    title       VARCHAR(300) NOT NULL,
    description TEXT,
    folder      VARCHAR(300),
    content     TEXT NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 1,
    created_by  VARCHAR(200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  VARCHAR(200),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN document.content IS 'Document body as JSON: page setup, parameters, sections and blocks';
COMMENT ON COLUMN document.revision IS 'Incremented on every save; a save carrying an older revision is rejected (409)';

-- Images and other binary assets used by documents; the bytes live in object storage (MinIO).
CREATE TABLE IF NOT EXISTS document_asset (
    id           BIGSERIAL PRIMARY KEY,
    document_id  BIGINT REFERENCES document(id) ON DELETE CASCADE,
    object_key   VARCHAR(500) NOT NULL,
    filename     VARCHAR(300) NOT NULL,
    content_type VARCHAR(150),
    size_bytes   BIGINT,
    created_by   VARCHAR(200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_document_asset_doc ON document_asset(document_id);

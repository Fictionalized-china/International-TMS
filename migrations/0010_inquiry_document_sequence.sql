PRAGMA foreign_keys = OFF;

CREATE TABLE document_sequences_new (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('inquiry','quote','order','shipment','invoice')),
  next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id,document_type)
);

INSERT INTO document_sequences_new(organization_id,document_type,next_value)
SELECT organization_id,document_type,next_value FROM document_sequences;

DROP TABLE document_sequences;
ALTER TABLE document_sequences_new RENAME TO document_sequences;

PRAGMA foreign_keys = ON;

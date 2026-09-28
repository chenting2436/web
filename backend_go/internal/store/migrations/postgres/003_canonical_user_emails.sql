-- Refuse ambiguous legacy data before canonicalizing it. Because PostgreSQL
-- migrations run in one transaction, case-only duplicates roll everything
-- back instead of selecting an arbitrary account for an OIDC subject.
CREATE UNIQUE INDEX users_tenant_email_canonical_key
    ON users (tenant_id, lower(email));

UPDATE users
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));

ALTER TABLE users
    ADD CONSTRAINT users_email_canonical
    CHECK (email = lower(btrim(email)));

-- Application users for JWT login + RBAC.
-- Roles: ADMIN (full write incl. /reports) · USER (authenticated, no report writes).
CREATE TABLE app_user (
    id            BIGSERIAL    PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,          -- BCrypt ($2a$10$…, 60 chars)
    role          VARCHAR(16)  NOT NULL DEFAULT 'USER'
                  CHECK (role IN ('ADMIN','USER')),
    display_name  VARCHAR(128)
);

-- Seed accounts (DEV credentials — rotate for production):
--   admin   / admin   -> ROLE ADMIN, 'Report Admin'
--   analyst / analyst -> ROLE USER,  'Report Analyst'
-- Hashes computed with Spring Security BCryptPasswordEncoder (strength 10) and verified.
INSERT INTO app_user (username, password_hash, role, display_name) VALUES
    ('admin',   '$2a$10$DgTc2v5mXVNKlRUEEE8Oou9618mQsct5K.Ing7NnxqyQFJoJj/KoS', 'ADMIN', 'Report Admin'),
    ('analyst', '$2a$10$XZ/mv2CunQ4nWfWzKd9BIO4BoGkL/uR8jAtsggyEwrAonf055CbBe', 'USER',  'Report Analyst');

"""v28: connector tokens and codes carry the approved scope."""
import duckdb

from schema import ANALYTICS_MIGRATIONS, ensure_analytics_schema


def test_scope_columns_exist_and_upgrade():
    con = duckdb.connect()
    ensure_analytics_schema(con)
    con.execute(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, created_at, expires_at, revoked, scope) "
        "VALUES ('h', 'access', 'c', NOW(), NOW(), FALSE, 'dissent:read dissent:log')"
    )
    assert con.execute("SELECT scope FROM oauth_tokens").fetchone()[0] == "dissent:read dissent:log"
    assert "scope" in {r[0] for r in con.execute("DESCRIBE oauth_codes").fetchall()}
    # Production was created at v27, so the columns must also arrive by migration.
    assert "ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS scope VARCHAR" in ANALYTICS_MIGRATIONS
    assert "ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS scope VARCHAR" in ANALYTICS_MIGRATIONS

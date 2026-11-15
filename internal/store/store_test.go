package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

var usageColumns = []string{
	"admin_key", "balance_usd", "balance_at", "balance_baseline_usd", "alert_below_usd",
	"usage_interval_s", "usage_spent_month_usd", "usage_since_balance_usd", "usage_checked_at", "usage_error",
}

func accountColumns(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`PRAGMA table_info(accounts)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &kind, &notNull, &dflt, &pk); err != nil {
			t.Fatal(err)
		}
		cols[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return cols
}

func TestMigrationAddsUsageColumnsToAnEmptyDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "weaver.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cols := accountColumns(t, db)
	for _, name := range usageColumns {
		if !cols[name] {
			t.Errorf("accounts is missing %s", name)
		}
	}
}

// makeVersionTwo builds a database that has exactly 0001 and 0002 applied, as
// an installation from before this change would have.
func makeVersionTwo(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_advisory_auto_accept.sql"} {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := db.Exec(`INSERT INTO schema_migrations(name, applied_at) VALUES(?, 0)`, name); err != nil {
			t.Fatal(err)
		}
	}
	// An account from before the upgrade must keep its data and get defaults.
	if _, err := db.Exec(`INSERT INTO accounts(id, engine, kind, label, api_key, created_at) VALUES('old','dsh','api','旧渠道','sk-old',1)`); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationUpgradesAVersionTwoDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "weaver.db")
	makeVersionTwo(t, path)
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cols := accountColumns(t, db)
	for _, name := range usageColumns {
		if !cols[name] {
			t.Errorf("upgraded accounts is missing %s", name)
		}
	}
	var adminKey, usageError, label string
	var interval int
	var balance sql.NullFloat64
	if err := db.QueryRow(`SELECT admin_key, usage_error, usage_interval_s, balance_usd, label FROM accounts WHERE id='old'`).
		Scan(&adminKey, &usageError, &interval, &balance, &label); err != nil {
		t.Fatal(err)
	}
	if adminKey != "" || usageError != "" || interval != 300 || balance.Valid || label != "旧渠道" {
		t.Fatalf("old row after upgrade: admin_key=%q usage_error=%q interval=%d balance=%v label=%q", adminKey, usageError, interval, balance, label)
	}
	var applied int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE name='0003_account_usage.sql'`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != 1 {
		t.Fatalf("0003 applied %d times", applied)
	}
}

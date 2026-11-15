package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

var usageColumns = []string{"balance_usd", "balance_at", "alert_below_usd"}

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
	var label string
	var balance sql.NullFloat64
	if err := db.QueryRow(`SELECT balance_usd, label FROM accounts WHERE id='old'`).Scan(&balance, &label); err != nil {
		t.Fatal(err)
	}
	if balance.Valid || label != "旧渠道" {
		t.Fatalf("old row after upgrade: balance=%v label=%q", balance, label)
	}
	var applied int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE name='0003_account_usage.sql'`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != 1 {
		t.Fatalf("0003 applied %d times", applied)
	}
}

func TestMigrationFourUpgradesVersionThree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "weaver.db")
	makeVersionTwo(t, path)
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	body, err := migrations.ReadFile("migrations/0003_account_usage.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec(string(body)); err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec(`INSERT INTO schema_migrations VALUES('0003_account_usage.sql',0); INSERT INTO missions(id,title,workspace,created_at) VALUES('old','old','/tmp',1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var engine, session string
	var archived sql.NullInt64
	if err = db.QueryRow(`SELECT owner_engine,owner_session,archived_at FROM missions WHERE id='old'`).Scan(&engine, &session, &archived); err != nil {
		t.Fatal(err)
	}
	if engine != "" || session != "" || archived.Valid {
		t.Fatal("invalid defaults")
	}
	if _, err = db.Exec(`INSERT INTO artifacts(id,mission_id,kind,title,group_key,created_at) VALUES('a','old','doc','Doc','Doc',1)`); err != nil {
		t.Fatal(err)
	}
	if err = migrate(db); err != nil {
		t.Fatal(err)
	}
}

// TestMigrationFiveKeepsTheBalanceOfAVersionFourDatabase upgrades a database
// as v2.1.0 left it: an admin key, a balance and its query results. The hand
// entered balance, its time and the alert line must survive; the run history
// gets the new usage columns with their defaults.
func TestMigrationFiveKeepsTheBalanceOfAVersionFourDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "weaver.db")
	makeVersionTwo(t, path)
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	old.SetMaxOpenConns(1)
	for _, name := range []string{"0003_account_usage.sql", "0004_mission_owner_artifacts.sql"} {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := old.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := old.Exec(`INSERT INTO schema_migrations(name, applied_at) VALUES(?, 0)`, name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := old.Exec(`UPDATE accounts SET admin_key='sk-ant-admin', balance_usd=50, balance_at=1700, alert_below_usd=5,
		usage_spent_month_usd=3, usage_error='x' WHERE id='old';
		INSERT INTO missions(id,title,workspace,created_at) VALUES('m','m','/tmp',1);
		INSERT INTO packages(id,mission_id,key,title,instruction,workspace,state,position,created_at,updated_at) VALUES('p','m','k','k','do','/tmp','running',0,1,1);
		INSERT INTO attempts(id,package_id,mission_id,n,state,worker,account_id,engine,model,effort,mode,input_tokens,output_tokens,created_at)
			VALUES('t','p','m',1,'failed','w','old','dsh','m','','cold',10,2,1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	for round := 0; round < 2; round++ {
		db, err := Open(path)
		if err != nil {
			t.Fatalf("open %d: %v", round, err)
		}
		cols := accountColumns(t, db)
		if cols["admin_key"] {
			t.Fatal("admin_key survived the upgrade")
		}
		var balance, alert sql.NullFloat64
		var at sql.NullInt64
		if err := db.QueryRow(`SELECT balance_usd, balance_at, alert_below_usd FROM accounts WHERE id='old'`).Scan(&balance, &at, &alert); err != nil {
			t.Fatal(err)
		}
		if balance.Float64 != 50 || at.Int64 != 1700 || alert.Float64 != 5 {
			t.Fatalf("balance=%v at=%v alert=%v", balance, at, alert)
		}
		var in, cacheRead int
		var cost sql.NullFloat64
		if err := db.QueryRow(`SELECT input_tokens, cache_read_tokens, cost_usd FROM attempts WHERE id='t'`).Scan(&in, &cacheRead, &cost); err != nil {
			t.Fatal(err)
		}
		if in != 10 || cacheRead != 0 || cost.Valid {
			t.Fatalf("attempt after upgrade: in=%d cacheRead=%d cost=%v", in, cacheRead, cost)
		}
		db.Close()
	}
}

func TestIntelligenceMigrationUpgradesAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "weaver.db")
	makeVersionTwo(t, path)
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec(`INSERT INTO workers(id,engine,model,weight) VALUES('w','codex','m',8)`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	for i := 0; i < 2; i++ {
		db, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		var score float64
		if err := db.QueryRow(`SELECT intelligence FROM workers WHERE id='w'`).Scan(&score); err != nil {
			db.Close()
			t.Fatal(err)
		}
		if score != 0 {
			db.Close()
			t.Fatalf("legacy candidate was automatically scored %g", score)
		}
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('workers') WHERE name='weight'`).Scan(&count); err != nil {
			db.Close()
			t.Fatal(err)
		}
		if count != 0 {
			db.Close()
			t.Fatal("legacy column retained")
		}
		if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE name='0006_worker_intelligence.sql'`).Scan(&count); err != nil {
			db.Close()
			t.Fatal(err)
		}
		if count != 1 {
			db.Close()
			t.Fatal(count)
		}
		for _, col := range []string{"quota", "quota_checked_at", "quota_error"} {
			if !accountColumns(t, db)[col] {
				db.Close()
				t.Fatalf("missing %s", col)
			}
		}
		db.Close()
	}
}

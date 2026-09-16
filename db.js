// db.js
// -----------------------------------------------------------------------------
// Usamos SQLite (better-sqlite3) para que el proyecto corra en cualquier laptop
// sin instalar un servidor aparte. El diseño de tablas es 1:1 compatible con
// PostgreSQL (tipos equivalentes anotados en comentarios) para que migrar sea
// solo cambiar el driver, no rediseñar el esquema.
// -----------------------------------------------------------------------------

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "elite_striker.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS User_Profile (
  user_id             INTEGER PRIMARY KEY AUTOINCREMENT, -- SERIAL en Postgres
  name                TEXT NOT NULL,
  age                 INTEGER,
  position             TEXT NOT NULL,      -- Portero, Central, Lateral, Mediocampista, Extremo, Delantero
  injury_history       TEXT DEFAULT '[]',  -- JSON array (usar JSONB en Postgres)
  vo2_max_baseline     REAL,
  one_rm_squat         REAL,
  body_weight_kg       REAL,
  match_day            TEXT DEFAULT 'Saturday' -- dia de partido, ancla del motor de tapering
);

CREATE TABLE IF NOT EXISTS Daily_Wellness (
  wellness_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES User_Profile(user_id),
  date                TEXT NOT NULL,       -- YYYY-MM-DD
  sleep_hrs           REAL NOT NULL,
  muscle_soreness     INTEGER NOT NULL,    -- 1-10
  stress              INTEGER NOT NULL,    -- 1-10
  hrv                 REAL,                -- opcional, viene de wearable (HealthKit/Oura/WHOOP)
  source              TEXT DEFAULT 'manual', -- manual | healthkit | google_fit | oura | whoop
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS Exercises (
  exercise_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  video_url           TEXT,
  type                TEXT NOT NULL,       -- Fuerza, Cardio, Tactico, Recuperacion
  load_impact         INTEGER NOT NULL,    -- 1-10, impacto en el sistema nervioso
  position_tags       TEXT DEFAULT '["all"]' -- JSON array de posiciones a las que aplica
);

CREATE TABLE IF NOT EXISTS Workouts_Log (
  log_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES User_Profile(user_id),
  exercise_id         INTEGER REFERENCES Exercises(exercise_id),
  date                TEXT NOT NULL,
  duration_mins       INTEGER NOT NULL,
  rpe_score           INTEGER,             -- 1-10, se llena al terminar la sesion (popup Borg)
  total_load          INTEGER,             -- duration_mins * rpe_score
  planned             INTEGER DEFAULT 0,   -- 1 = sesion programada por el motor de tapering/ACWR
  session_type        TEXT                 -- copia de Exercises.type al momento del log
);
`);

function seedExercisesIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM Exercises").get().c;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO Exercises (name, video_url, type, load_impact, position_tags)
    VALUES (@name, @video_url, @type, @load_impact, @position_tags)
  `);

  const exercises = [
    { name: "Sprint 30m repeticiones", video_url: "https://youtu.be/example-sprint", type: "Cardio", load_impact: 9, position_tags: JSON.stringify(["Extremo", "Delantero", "Lateral"]) },
    { name: "Cambios de ritmo con balon", video_url: "https://youtu.be/example-ritmo", type: "Tactico", load_impact: 7, position_tags: JSON.stringify(["Extremo", "Delantero"]) },
    { name: "Juego de posicion 4v2", video_url: "https://youtu.be/example-rondo", type: "Tactico", load_impact: 6, position_tags: JSON.stringify(["Mediocampista", "Central"]) },
    { name: "Salida de balon bajo presion", video_url: "https://youtu.be/example-salida", type: "Tactico", load_impact: 5, position_tags: JSON.stringify(["Central", "Portero"]) },
    { name: "Fuerza tren inferior (sentadilla/peso muerto)", video_url: "https://youtu.be/example-fuerza", type: "Fuerza", load_impact: 8, position_tags: JSON.stringify(["all"]) },
    { name: "Pliometria y saltos", video_url: "https://youtu.be/example-pliometria", type: "Fuerza", load_impact: 7, position_tags: JSON.stringify(["all"]) },
    { name: "Movilidad y estiramiento", video_url: "https://youtu.be/example-estiramiento", type: "Recuperacion", load_impact: 2, position_tags: JSON.stringify(["all"]) },
    { name: "Foam rolling + respiracion", video_url: "https://youtu.be/example-foam", type: "Recuperacion", load_impact: 1, position_tags: JSON.stringify(["all"]) },
    { name: "Trabajo aerobico continuo (Zona 2)", video_url: "https://youtu.be/example-zona2", type: "Cardio", load_impact: 4, position_tags: JSON.stringify(["all"]) },
    { name: "Duelos 1v1 defensivos", video_url: "https://youtu.be/example-1v1def", type: "Tactico", load_impact: 6, position_tags: JSON.stringify(["Central", "Lateral"]) },
  ];

  const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  tx(exercises);
}

seedExercisesIfEmpty();

module.exports = db;

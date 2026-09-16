// server.js
const path = require("path");
const express = require("express");
const cors = require("cors");
const db = require("./db");
const {
  calculateACWR,
  taperingPlan,
  readinessSemaphore,
  nutritionSuggestion,
} = require("./algorithms");
const { runDailyJob, scheduleDailyJob } = require("./cron");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. USER PROFILE
// ---------------------------------------------------------------------------
app.post("/api/profile", (req, res) => {
  const { name, age, position, injury_history, vo2_max_baseline, one_rm_squat, body_weight_kg, match_day } = req.body;
  if (!name || !position) return res.status(400).json({ error: "name y position son obligatorios" });

  const stmt = db.prepare(`
    INSERT INTO User_Profile (name, age, position, injury_history, vo2_max_baseline, one_rm_squat, body_weight_kg, match_day)
    VALUES (@name, @age, @position, @injury_history, @vo2_max_baseline, @one_rm_squat, @body_weight_kg, @match_day)
  `);
  const info = stmt.run({
    name,
    age: age || null,
    position,
    injury_history: JSON.stringify(injury_history || []),
    vo2_max_baseline: vo2_max_baseline || null,
    one_rm_squat: one_rm_squat || null,
    body_weight_kg: body_weight_kg || null,
    match_day: match_day || "Saturday",
  });
  res.json({ user_id: info.lastInsertRowid });
});

app.get("/api/profile/:userId", (req, res) => {
  const row = db.prepare("SELECT * FROM User_Profile WHERE user_id = ?").get(req.params.userId);
  if (!row) return res.status(404).json({ error: "no encontrado" });
  res.json(row);
});

// ---------------------------------------------------------------------------
// 2. DAILY WELLNESS (el blocker del frontend)
// ---------------------------------------------------------------------------
app.post("/api/wellness", (req, res) => {
  const { user_id, date, sleep_hrs, muscle_soreness, stress, hrv, source } = req.body;
  if (!user_id || !date || sleep_hrs == null || muscle_soreness == null || stress == null) {
    return res.status(400).json({ error: "user_id, date, sleep_hrs, muscle_soreness, stress son obligatorios" });
  }
  db.prepare(`
    INSERT INTO Daily_Wellness (user_id, date, sleep_hrs, muscle_soreness, stress, hrv, source)
    VALUES (@user_id, @date, @sleep_hrs, @muscle_soreness, @stress, @hrv, @source)
    ON CONFLICT(user_id, date) DO UPDATE SET
      sleep_hrs=excluded.sleep_hrs, muscle_soreness=excluded.muscle_soreness,
      stress=excluded.stress, hrv=excluded.hrv, source=excluded.source
  `).run({ user_id, date, sleep_hrs, muscle_soreness, stress, hrv: hrv || null, source: source || "manual" });

  res.json(readinessSemaphore(user_id, date));
});

// ---------------------------------------------------------------------------
// 3. EXERCISES (filtrados por posicion)
// ---------------------------------------------------------------------------
app.get("/api/exercises", (req, res) => {
  const { position } = req.query;
  const all = db.prepare("SELECT * FROM Exercises").all();
  const filtered = position
    ? all.filter((e) => {
        const tags = JSON.parse(e.position_tags);
        return tags.includes("all") || tags.includes(position);
      })
    : all;
  res.json(filtered);
});

// ---------------------------------------------------------------------------
// 4. WORKOUTS LOG (popup RPE al terminar la sesion)
// ---------------------------------------------------------------------------
app.post("/api/workouts", (req, res) => {
  const { user_id, exercise_id, date, duration_mins, rpe_score } = req.body;
  if (!user_id || !date || !duration_mins || rpe_score == null) {
    return res.status(400).json({ error: "user_id, date, duration_mins, rpe_score son obligatorios" });
  }
  const total_load = duration_mins * rpe_score;
  const exercise = exercise_id ? db.prepare("SELECT type FROM Exercises WHERE exercise_id = ?").get(exercise_id) : null;

  const info = db.prepare(`
    INSERT INTO Workouts_Log (user_id, exercise_id, date, duration_mins, rpe_score, total_load, planned, session_type)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(user_id, exercise_id || null, date, duration_mins, rpe_score, total_load, exercise ? exercise.type : null);

  res.json({
    log_id: info.lastInsertRowid,
    total_load,
    acwr_after: calculateACWR(user_id, date),
    nutrition: nutritionSuggestion(user_id, date),
  });
});

app.get("/api/workouts/:userId", (req, res) => {
  const rows = db.prepare("SELECT * FROM Workouts_Log WHERE user_id = ? ORDER BY date DESC").all(req.params.userId);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// 5. DASHBOARD DE READINESS (pantalla de inicio: semaforo)
// ---------------------------------------------------------------------------
app.get("/api/dashboard/:userId", (req, res) => {
  const date = req.query.date || today();
  res.json(readinessSemaphore(req.params.userId, date));
});

// ---------------------------------------------------------------------------
// 6. ACWR crudo
// ---------------------------------------------------------------------------
app.get("/api/acwr/:userId", (req, res) => {
  const date = req.query.date || today();
  res.json(calculateACWR(req.params.userId, date));
});

// ---------------------------------------------------------------------------
// 7. TAPERING
// ---------------------------------------------------------------------------
app.get("/api/tapering/:userId", (req, res) => {
  try {
    const profile = db.prepare("SELECT match_day FROM User_Profile WHERE user_id = ?").get(req.params.userId);
    const matchDay = req.query.matchDay || (profile && profile.match_day) || "Saturday";
    res.json(taperingPlan(req.params.userId, matchDay, req.query.date));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 8. NUTRICION REACTIVA
// ---------------------------------------------------------------------------
app.get("/api/nutrition/:userId", (req, res) => {
  const date = req.query.date || today();
  res.json(nutritionSuggestion(req.params.userId, date));
});

// ---------------------------------------------------------------------------
// 9. CRON manual trigger (para demo; en produccion corre solo a las 4am)
// ---------------------------------------------------------------------------
app.post("/api/cron/run", (req, res) => {
  res.json(runDailyJob(req.body.date));
});

// ---------------------------------------------------------------------------
// 10. INTEGRACIONES EXTERNAS (stubs) - HealthKit / Google Fit / Oura / WHOOP
// En produccion cada uno de estos endpoints haria el intercambio OAuth2.0 real
// y guardaria sleep_hrs/hrv en Daily_Wellness con source = el proveedor.
// ---------------------------------------------------------------------------
app.post("/api/integrations/healthkit/sync", (req, res) => {
  const { user_id, date, sleep_hrs, hrv } = req.body;
  db.prepare(`
    INSERT INTO Daily_Wellness (user_id, date, sleep_hrs, muscle_soreness, stress, hrv, source)
    VALUES (?, ?, ?, COALESCE((SELECT muscle_soreness FROM Daily_Wellness WHERE user_id=? AND date=?),5),
            COALESCE((SELECT stress FROM Daily_Wellness WHERE user_id=? AND date=?),5), ?, 'healthkit')
    ON CONFLICT(user_id, date) DO UPDATE SET sleep_hrs=excluded.sleep_hrs, hrv=excluded.hrv, source='healthkit'
  `).run(user_id, date, sleep_hrs, user_id, date, user_id, date, hrv || null);
  res.json({ synced: true, provider: "healthkit" });
});

app.post("/api/integrations/oura/oauth/callback", (req, res) => {
  // Stub: aqui se intercambiaria el `code` por un access_token real via OAuth2.0
  res.json({ connected: true, provider: "oura", note: "Stub - integrar OAuth2.0 real con el SDK de Oura." });
});

app.post("/api/integrations/whoop/oauth/callback", (req, res) => {
  res.json({ connected: true, provider: "whoop", note: "Stub - integrar OAuth2.0 real con el SDK de WHOOP." });
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Elite Striker backend corriendo en http://localhost:${PORT}`);
  scheduleDailyJob();
});

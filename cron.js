// cron.js
// -----------------------------------------------------------------------------
// Cronjob diario (simulado con node-cron) que recorre a todos los usuarios y:
//  1. Recalcula su ACWR.
//  2. Si estan en zona de riesgo, marca en Workouts_Log una sesion "planned"
//     de tipo Recuperacion para el dia de hoy (esto es lo que el Frontend
//     lee para decidir que mostrar en el Dashboard / Modulo de Sesion).
// En produccion esto correria en un worker separado (ej. BullMQ + Redis),
// aqui esta simplificado para que se pueda ejecutar y demostrar localmente.
// -----------------------------------------------------------------------------

const cron = require("node-cron");
const db = require("./db");
const { applyInjuryRiskTrigger } = require("./algorithms");

function fmtToday() {
  return new Date().toISOString().slice(0, 10);
}

function runDailyJob(date) {
  const today = date || fmtToday();
  const users = db.prepare("SELECT user_id FROM User_Profile").all();
  const results = [];

  for (const { user_id } of users) {
    const outcome = applyInjuryRiskTrigger(user_id, today, null);
    if (outcome.overridden && outcome.exercise_id) {
      const exists = db
        .prepare(`SELECT log_id FROM Workouts_Log WHERE user_id = ? AND date = ? AND planned = 1`)
        .get(user_id, today);
      if (!exists) {
        db.prepare(
          `INSERT INTO Workouts_Log (user_id, exercise_id, date, duration_mins, rpe_score, total_load, planned, session_type)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'Recuperacion')`
        ).run(user_id, outcome.exercise_id, today, 20, null, null);
      }
    }
    results.push({ user_id, ...outcome });
  }
  return results;
}

function scheduleDailyJob() {
  // Corre todos los dias a las 04:00 (antes de que el jugador despierte y abra la app)
  cron.schedule("0 4 * * *", () => {
    console.log(`[cron] Ejecutando recalculo diario de ACWR - ${fmtToday()}`);
    runDailyJob();
  });
}

module.exports = { runDailyJob, scheduleDailyJob };

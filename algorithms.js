// algorithms.js
// -----------------------------------------------------------------------------
// El "cerebro" de la app. Todo lo que aqui se calcula corre tambien via cronjob
// diario (ver cron.js) para que el Dashboard nunca dependa de un calculo hecho
// en el momento en el request del usuario.
// -----------------------------------------------------------------------------

const db = require("./db");

function toDate(d) {
  return d instanceof Date ? d : new Date(d + "T00:00:00");
}
function fmt(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(baseDate, n) {
  const d = new Date(toDate(baseDate));
  d.setDate(d.getDate() - n);
  return fmt(d);
}

/**
 * ACWR = Carga Aguda (suma ultimos 7 dias) / Carga Cronica (promedio semanal ultimos 28 dias)
 */
function calculateACWR(userId, asOfDate) {
  const acuteStart = daysAgo(asOfDate, 6); // ventana de 7 dias incluyendo hoy
  const chronicStart = daysAgo(asOfDate, 27); // ventana de 28 dias incluyendo hoy

  const acuteRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_load),0) AS s FROM Workouts_Log
       WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 0`
    )
    .get(userId, acuteStart, asOfDate);

  const chronicRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_load),0) AS s FROM Workouts_Log
       WHERE user_id = ? AND date BETWEEN ? AND ? AND planned = 0`
    )
    .get(userId, chronicStart, asOfDate);

  const acute = acuteRow.s;
  const chronicWeeklyAvg = chronicRow.s / 4; // 28 dias = 4 semanas
  const ratio = chronicWeeklyAvg > 0 ? acute / chronicWeeklyAvg : 0;

  return {
    acute_load_7d: acute,
    chronic_weekly_avg_28d: Number(chronicWeeklyAvg.toFixed(2)),
    acwr: Number(ratio.toFixed(2)),
    risk_zone: ratio > 1.5, // regla de negocio: >1.5 = riesgo de lesion inminente
  };
}

/**
 * Si ACWR > 1.5, el backend debe reemplazar la sesion de alta intensidad
 * programada para HOY por una de tipo Recuperacion.
 * Devuelve la sesion final que el frontend debe mostrar.
 */
function applyInjuryRiskTrigger(userId, date, plannedExerciseId) {
  const acwrResult = calculateACWR(userId, date);

  if (!acwrResult.risk_zone) {
    return { acwr: acwrResult, overridden: false, exercise_id: plannedExerciseId };
  }

  const recovery = db
    .prepare(`SELECT * FROM Exercises WHERE type = 'Recuperacion' ORDER BY load_impact ASC LIMIT 1`)
    .get();

  return {
    acwr: acwrResult,
    overridden: true,
    reason: "ACWR > 1.5: riesgo de lesion inminente. Sesion reemplazada automaticamente.",
    exercise_id: recovery ? recovery.exercise_id : null,
    exercise: recovery || null,
  };
}

/**
 * Motor de Tapering: dado el dia de partido, calcula cuanto debe caer la
 * carga programada el D-2 (jueves si el partido es sabado) y D-1 (viernes),
 * respecto al pico de carga del martes/miercoles de esa misma semana.
 */
const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const INDEX_DAY = Object.fromEntries(Object.entries(DAY_INDEX).map(([k, v]) => [v, k]));

function getWeekDates(anyDateInWeek) {
  const d = toDate(anyDateInWeek);
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dow + 6) % 7)); // retrocede a lunes
  const week = {};
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    week[INDEX_DAY[day.getDay()]] = fmt(day);
  }
  return week;
}

function taperingPlan(userId, matchDay, referenceDate) {
  const week = getWeekDates(referenceDate || fmt(new Date()));
  const matchDayIdx = DAY_INDEX[matchDay];
  if (matchDayIdx === undefined) {
    throw new Error("matchDay invalido. Usa: Sunday..Saturday");
  }

  // D-2 y D-1 relativos al dia de partido dentro de la misma semana
  const d2Date = fmt(new Date(new Date(toDate(week[matchDay])).setDate(toDate(week[matchDay]).getDate() - 2)));
  const d1Date = fmt(new Date(new Date(toDate(week[matchDay])).setDate(toDate(week[matchDay]).getDate() - 1)));

  // Pico de carga = maximo total_load registrado entre martes y miercoles de esa semana
  const peakRow = db
    .prepare(
      `SELECT MAX(total_load) AS peak FROM Workouts_Log
       WHERE user_id = ? AND date IN (?, ?)`
    )
    .get(userId, week.Tuesday, week.Wednesday);

  const peak = peakRow.peak || 0;

  return {
    match_day: matchDay,
    peak_load_tue_wed: peak,
    d2_date: d2Date,
    d1_date: d1Date,
    d2_target_load: Math.round(peak * 0.6), // cae 40%
    d1_target_load: Math.round(peak * 0.4), // cae 60%
    rule: "D-2 (jueves) cae 40% del pico; D-1 (viernes) cae 60% del pico.",
  };
}

/**
 * Semaforo de Readiness. CRITICO: si no existe Daily_Wellness para la fecha,
 * el jugador esta bloqueado y no puede ver su entrenamiento del dia.
 */
function readinessSemaphore(userId, date) {
  const wellness = db
    .prepare(`SELECT * FROM Daily_Wellness WHERE user_id = ? AND date = ?`)
    .get(userId, date);

  if (!wellness) {
    return { blocked: true, reason: "Debes llenar tu wellness diario antes de ver el entrenamiento." };
  }

  const acwrResult = calculateACWR(userId, date);

  // Puntuacion simple 0-100: penaliza poco sueno, dolor muscular alto, estres alto y ACWR fuera de rango optimo (0.8-1.3)
  let score = 100;
  score -= Math.max(0, (7 - wellness.sleep_hrs) * 8); // por debajo de 7h de sueno
  score -= wellness.muscle_soreness * 4;
  score -= wellness.stress * 3;
  if (acwrResult.acwr > 1.5) score -= 30;
  else if (acwrResult.acwr > 1.3) score -= 15;
  else if (acwrResult.acwr > 0 && acwrResult.acwr < 0.8) score -= 10; // subentrenamiento tambien resta

  score = Math.max(0, Math.min(100, Math.round(score)));

  let semaphore = "green";
  if (score < 50) semaphore = "red";
  else if (score < 75) semaphore = "yellow";

  return {
    blocked: false,
    score,
    semaphore, // green | yellow | red
    wellness,
    acwr: acwrResult,
  };
}

/**
 * Nutricion reactiva: si hoy hubo una sesion de alta depleccion de glucogeno
 * (Cardio / load_impact alto), sugiere gramos de carbohidratos post-entreno
 * en funcion del peso corporal.
 */
function nutritionSuggestion(userId, date) {
  const rows = db
    .prepare(
      `SELECT wl.*, e.type AS ex_type, e.load_impact
       FROM Workouts_Log wl LEFT JOIN Exercises e ON wl.exercise_id = e.exercise_id
       WHERE wl.user_id = ? AND wl.date = ?`
    )
    .all(userId, date);

  const highDepletion = rows.some((r) => (r.ex_type === "Cardio" && (r.load_impact || 0) >= 7) || (r.total_load || 0) >= 350);

  if (!highDepletion) {
    return { trigger: false };
  }

  const profile = db.prepare(`SELECT body_weight_kg FROM User_Profile WHERE user_id = ?`).get(userId);
  const weight = profile && profile.body_weight_kg ? profile.body_weight_kg : 70;
  const gramsPerKg = 1.2; // rango estandar 1.0-1.5 g/kg para recuperacion post-sesion de alta intensidad
  const grams = Math.round(weight * gramsPerKg);

  return {
    trigger: true,
    message: `Sesion de alta deplecion detectada. Consume aproximadamente ${grams}g de carbohidratos en los proximos 30-45 min (${gramsPerKg}g/kg x ${weight}kg).`,
    grams_carbs: grams,
  };
}

module.exports = {
  calculateACWR,
  applyInjuryRiskTrigger,
  taperingPlan,
  readinessSemaphore,
  nutritionSuggestion,
  getWeekDates,
};

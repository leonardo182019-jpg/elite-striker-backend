# Elite Striker — Backend de Performance

App full-stack construida exactamente sobre los 4 fundamentos que definiste. Backend
en Node.js/Express, base de datos relacional, cronjob diario, y un frontend (SPA en
un solo HTML) que consume todo vía API para demostrar cada módulo.

## Cómo correrlo

```bash
npm install
npm start
```

Abre `http://localhost:3000`. Crea un perfil (posición + peso + día de partido),
llena el wellness del día y ya puedes navegar Dashboard / Sesión / Táctica / Nutrición.

## 1. Base de datos (Core Schemas)

Se usó **SQLite** (`better-sqlite3`) en vez de un servidor Postgres aparte, para que
el proyecto corra en cualquier máquina sin infraestructura extra. El esquema
(`src/db.js`) es 1:1 compatible con PostgreSQL: mismas tablas, mismas columnas,
mismos tipos equivalentes (`INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL`, JSON en
texto → `JSONB`). Migrar es cambiar el driver, no rediseñar nada.

- **User_Profile**: incluye `position`, que es el filtro real usado en
  `GET /api/exercises?position=...` — cada ejercicio tiene `position_tags` y solo se
  muestran los que aplican a esa posición (o `"all"`).
- **Daily_Wellness**: `UNIQUE(user_id, date)`. Es el blocker real: `GET /api/dashboard/:id`
  devuelve `{blocked: true}` si no existe el registro del día, y el frontend no
  renderiza el entrenamiento hasta que se llena.
- **Exercises**: seed inicial con 10 ejercicios reales con `load_impact` diferenciado
  (sprint = 9, estiramiento = 2, tal como pediste).
- **Workouts_Log**: `total_load` se calcula en el backend (`duration_mins * rpe_score`),
  nunca confiado al cliente.

## 2. El "cerebro" (`src/algorithms.js` + `src/cron.js`)

- **ACWR**: `carga aguda (suma últimos 7 días) / carga crónica (promedio semanal de
  los últimos 28 días)`. Si `ACWR > 1.5` → `risk_zone: true`.
- **Trigger de riesgo**: `applyInjuryRiskTrigger` reemplaza la sesión de hoy por el
  ejercicio de `Recuperacion` con menor `load_impact`. El cronjob (`node-cron`, todos
  los días 4:00am) corre esto para todos los usuarios y lo inserta como sesión
  `planned=1` en `Workouts_Log`. También hay un endpoint manual
  `POST /api/cron/run` para probarlo sin esperar al cron real.
- **Tapering**: dado el `match_day` del perfil, calcula el pico de carga entre
  martes/miércoles de esa semana y fuerza jueves (D-2) = 60% del pico (cae 40%) y
  viernes (D-1) = 40% del pico (cae 60%), exactamente como especificaste.

## 3. Frontend (`public/index.html`)

Un solo HTML con tabs, siguiendo el mismo patrón que ya usas en Striker Elite
(single-file, sin build step):

- **Dashboard de Readiness**: semáforo verde/amarillo/rojo alimentado por
  ACWR + Daily_Wellness. Sin videos de fútbol en la pantalla de inicio.
- **Módulo de Sesión**: reproductor de `<video>` nativo + cronómetro incorporado
  (start/pause/reset, sin salir de la app), y al terminar dispara el popup
  obligatorio de RPE (escala de Borg 1-10) que alimenta `Workouts_Log`.
- **Pizarra táctica**: heatmap SVG con zonas de posicionamiento según la posición
  del jugador (simplificado — ver nota abajo).
- **Nutrición reactiva**: si la sesión del día fue de alta depleción (Cardio con
  `load_impact >= 7`, o `total_load >= 350`), sugiere gramos de carbohidratos según
  peso corporal (`1.2 g/kg`).

## 4. Integraciones externas

Implementadas como **stubs funcionales** en `src/server.js`
(`/api/integrations/healthkit/sync`, `/api/integrations/oura/oauth/callback`,
`/api/integrations/whoop/oauth/callback`): la arquitectura y el punto de entrada ya
existen (guardan `sleep_hrs`/`hrv` en `Daily_Wellness` con el `source` correcto),
pero el intercambio OAuth2.0 real con Apple HealthKit, Google Fit, Oura y WHOOP
requiere credenciales de desarrollador de cada plataforma que no puedo generar
desde aquí — ahí es donde tu equipo conecta sus SDKs reales.

## Notas honestas sobre el alcance

- La pizarra táctica usa zonas fijas por posición (reglas simples), no un motor de
  simulación de heatmaps con datos reales de partidos — eso requeriría un dataset de
  tracking (ej. tipo StatsBomb/Opta) que no viene incluido.
- El cron corre dentro del mismo proceso Express con `node-cron`; en producción con
  múltiples usuarios concurrentes conviene moverlo a un worker separado
  (BullMQ + Redis) para no bloquear el event loop.
- Para pasar a Postgres real: instala `pg`, cambia el `require("better-sqlite3")` por
  el pool de `pg`, y ajusta la sintaxis `ON CONFLICT` (ya es compatible) y los
  autoincrement a `SERIAL`.

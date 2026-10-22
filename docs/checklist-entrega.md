# Lista final de chequeos antes de presentar el proyecto

Upwork Auto-Bidder para Siv (LTV Labs). Hay que repasar esta lista antes de la entrega (M8) y marcar cada punto.
Si un punto falla, se anota abajo, en "Notas", con la fecha.

## 1. Loom (M5)

- [ ] **Settings → Loom video** dice **Connected**, con la fecha **"session valid until …"**.
- [ ] **Renovación automática:** al día siguiente de conectar (se conectó el 22/10 con vencimiento 21/11/2026), la fecha "valid until" es **posterior** a la que se escribió
      al conectar. Si no cambió, Loom no renueva la sesión sola y hay que reconectar a mano antes de cada vencimiento.
      En ese caso se le explica a Siv (ver SOP) y se depende del aviso por email.
- [ ] **Aviso de vencimiento:** con el email configurado (punto 3), llega el aviso **7 días antes** del vencimiento. Para
      probarlo, reconectar escribiendo una fecha de vencimiento dentro de los próximos 7 días y esperar el próximo
      ciclo de 5 minutos. Después reconectar con la fecha real.
- [ ] **Aviso de desconexión:** si Loom rechaza la sesión, llega el email "Loom disconnected" y el dashboard lo muestra en rojo.
- [ ] Una propuesta nueva de la Review queue tiene **su propia copia** de Loom, con el **título del trabajo** como nombre.
- [ ] En la biblioteca de Loom **no quedan** videos "Connection test" ni "Session check".
- [ ] **Contador de vistas:** se decidió con Siv si se ocultan las vistas en las copias y, si se ocultan, quedó configurado en Loom.
- [ ] **Limpieza:** las copias de más de 30 días se borran solas. Se revisa después del primer mes, o con un valor
      menor en "Delete copies after" para probarlo.

## 2. Upwork y envío (M6)

- [ ] Upwork **Connected** con la cuenta de Rafa, y el saldo de Connects se lee bien.
- [ ] Hay **Connects** en la cuenta de Rafa. La alerta de 250 está configurada.
- [ ] **"Rafa's hourly rate"** está en Settings con el valor que confirmó Siv.
- [ ] **Día completo en modo Review:** Siv o Celia revisaron las propuestas de un día entero y la calidad está aprobada.
- [ ] **Primer envío real:** Celia aprobó en el chat ese trabajo y esa carta antes del `confirm_preview`.
- [ ] Se paró el proceso de envío de la agencia, para que el mismo cliente no reciba dos propuestas de Rafa.
- [ ] **Auto mode lo activa solo Siv** desde el dashboard. El código nunca lo activa.
- [ ] Términos de precio fijo (Dispute Assistance) aceptados por Siv en Settings, si se van a enviar trabajos de precio fijo.

## 3. Emails y reportes (M7)

- [ ] `RESEND_API_KEY` y `REPORT_FROM` (un remitente de un dominio verificado en Resend) están cargados en Cloudflare.
- [ ] **Settings → Report email** tiene la dirección de Siv. Si también se quiere la de Celia, el campo debe aceptar
      varias direcciones (pendiente del M7).
- [ ] Llega el **reporte diario** con números correctos.
- [ ] Llegan la **alerta de Connects bajos** y los **avisos de Loom** (vencimiento y desconexión).
- [ ] El **reporte de resultados** (vistas, respuestas, contrataciones por puntaje y por velocidad) coincide con Upwork en una muestra.

## 4. Seguridad

- [ ] Se rotó `TOKEN_KEY` en Cloudflare y se reconectaron Upwork y Loom después, porque una clave nueva invalida las sesiones guardadas.
- [ ] Se rotó el **Deploy Hook** de Cloudflare.
- [ ] No hay secretos, tokens ni la cookie de Loom en el repo ni en los logs. Para revisarlo, buscar en el repo y en
      Workers Logs `connect.sid`, `sk-ant`, `re_` y `Bearer`.
- [ ] La contraseña del dashboard (`DASH_PASSWORD`) es la definitiva y la tiene Siv.
- [ ] Siv aprobó el plan **Cloudflare Workers Paid ($5/mes)** antes de activar Auto.

## 5. Entrega (M8)

- [ ] `npm run typecheck` y `npm test` pasan en `main`.
- [ ] El **README** y el **`docs/SOP.md`** para Siv explican cómo cambiar las palabras clave, aprobar propuestas, pausar,
      **reconectar Upwork y Loom** (pasos de `connect.sid` y de la fecha de vencimiento), cambiar la API key y leer el reporte.
- [ ] Siv respondió las 8 preguntas: Connects, agencia, Freelancer Plus, tarifa, SMS y migraciones, Loom, día de revisión y Cloudflare.
- [ ] El repo se transfirió al GitHub de Siv y Workers Builds se reconectó a ese repo.
- [ ] Se hizo la demo con Siv: dashboard, Review queue, Settings y reporte.

## Notas


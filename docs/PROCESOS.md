# Procesos de operación y mantenimiento

Este documento dice qué hacer en cada situación: renovar credenciales, publicar cambios, responder a un incidente, agregar una lectura o validarla. Para el detalle de cada pieza, seguí los enlaces.

En los comandos, `campus` equivale a `node build/cli.js` ejecutado en la raíz del repositorio. Los comandos que piden o publican secretos los corrés **vos, en tu terminal**. Nunca pegues contraseñas, tokens, cookies ni enlaces `udesacampusmcp://…` en un chat, issue o captura.

## Mapa de credenciales

| Credencial | Para qué | Dónde vive | Cómo se renueva | Si se expone |
|---|---|---|---|---|
| Token del servicio móvil de Moodle | Todas las herramientas REST (la mayoría) | Local: Administrador de credenciales de Windows. Remoto: `CAMPUS_MOODLE_TOKEN` en Vercel | [Renovar el token móvil](#renovar-el-token-móvil) | [Incidente: token móvil](#token-móvil-expuesto) |
| Sesión web del Campus (cookie `MoodleSession`) | Estructura de cuestionarios, preguntas, reportes y overrides | Local: registro cifrado de la conexión en `web-connection.json`, en el directorio del perfil (ADR-142). Remoto: registro cifrado de la conexión en el KV (ADR-141) | [Renovar la sesión web](#renovar-la-sesión-web) | [Incidente: cookie](#cookie-de-sesión-web-expuesta) |
| `OAUTH_SIGNING_SECRET` | Firma los accesos de ChatGPT, Codex y Claude Code al remoto | Sólo en Vercel | `campus remote init-secret --profile udesa-docente` + `vercel deploy --prod` (desconecta a todos los clientes) | Rotarla |
| Secret de la OAuth App de GitHub | Login con GitHub del remoto | Sólo en Vercel | Generar uno nuevo en GitHub y cargarlo con `vercel env add GITHUB_CLIENT_SECRET production --sensitive` | Revocarlo en GitHub y cargar uno nuevo |
| Clave de firma de planes de escritura (`write-signing\|<perfil>`) | Detecta planes de escritura alterados en disco ([Escrituras](#escrituras)) | Local: Administrador de credenciales de Windows. Se crea sola la primera vez | Borrarla del Administrador de credenciales: se crea otra y los planes pendientes dejan de valer | Borrarla y volver a planificar |
| Clave de firma de planes remotos | Igual que la local, para `/mcp-completo` y `/mcp-escritura` | Derivada de `OAUTH_SIGNING_SECRET` (no se guarda aparte) | Rotar `OAUTH_SIGNING_SECRET` | Rotarla |
| Contraseña del Campus y cookie de dispositivo de confianza (`MFA_TOKEN_<userid>`), **sólo si activaste el login web automático** | Que el MCP local inicie sesión en la web solo (método recomendado en la PC; ADR-142; antes ADR-088) | Local: Administrador de credenciales de Windows (`web_login`, `web_trust`) | `auth web autologin enable` | Cambiar la contraseña del Campus (cierra todas las sesiones) y `auth web autologin disable` |
| Contraseña del Campus y confianza del dispositivo **del remoto** | Login web automático del remoto (ADR-127, ADR-141) | Contraseña: `CAMPUS_WEB_BOOTSTRAP` (o, en instalaciones previas, `CAMPUS_WEB_LOGIN`) en Vercel, sensible. Confianza y sesión: registro cifrado en el KV | [Panel `/admin/conexion`](#renovar-la-conexión-lo-habitual-cada-28-días) | Cambiar la contraseña del Campus y `remote autologin disable --redeploy` |
| `KV_REST_API_TOKEN` (Upstash) | Planes, interruptor, límites y auditoría de las escrituras remotas | Sólo en Vercel (integración del Marketplace) | Regenerarlo en Upstash y redesplegar | Regenerarlo; mientras tanto, quitar `CAMPUS_WRITE_ENABLED` |

Ninguna credencial está en el repositorio. Las variables de Vercel se listan con `vercel env ls production` (no muestra valores sensibles).

## Diagnóstico rápido

| Lo que ves | Qué significa | Proceso |
|---|---|---|
| `AUTH_REQUIRED` en casi todas las herramientas | Venció o se revocó el token móvil | [Renovar el token móvil](#renovar-el-token-móvil) |
| `AUTH_REQUIRED` sólo en estructura, preguntas, reportes u overrides, con «sesión web» en el mensaje | Venció la sesión web, o no está configurada | [Renovar la sesión web](#renovar-la-sesión-web) |
| `AUTH_REQUIRED` en lecturas web con `details.recovery.command` (MCP local) | La sesión web de esta PC venció y no se pudo renovar sola. El comando dice qué hacer según el método de la PC: `renew_local_trust` (renovar la confianza con el panel local), `enable_local_autologin` (activar el login automático) o, como alternativa, `import_web_cookie` | Corré ese comando en tu terminal ([síntomas por capa en la PC](#síntomas-por-capa-en-la-pc)); nunca pegues contraseñas, códigos ni cookies en el chat |
| `AUTH_REQUIRED` en lecturas web con «login web automático» en el mensaje | El login automático está desactivado (rechazo del Campus), frenado por los límites o sin canal para el código | `auth web autologin status`; si está desactivado, [volver a cargarlo](#login-web-automático-en-la-pc-recomendado) |
| En el remoto, `AUTH_REQUIRED` con `details.recovery` (`renew_web_trust`) o `campus_get_status` → `connection.action` | Venció o está por vencer la confianza del dispositivo del remoto | Abrí el panel `/admin/conexion` del remoto y [renová la conexión](#renovar-la-conexión-lo-habitual-cada-28-días); el código va en el panel, nunca en el chat |
| En el remoto, `connection.action.kind` = `cli_recovery` o `activate_recovery` | La configuración del remoto necesita la recuperación desde la PC, o hay una recuperación publicada sin activar | [Recuperación desde la PC](#recuperación-desde-la-pc-cli-adr-141) o «Activar y verificar recuperación» en el panel |
| Se abre un diálogo «Campus Virtual — código de verificación» | Venció la confianza del dispositivo (cada ~28 días) y el login automático necesita el código del correo | Escribí ahí el código que llegó a tu correo; nunca en el chat |
| `IDENTITY_MISMATCH` | La credencial es de otra cuenta de Moodle | Repetir el login o la importación con tu cuenta |
| El cliente remoto vuelve a pedir autorización | Pasaron 30 días o se rotó la clave de firma | Repetir el flujo de conexión ([CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md)) |
| El cliente no muestra una herramienta nueva | Guardó la lista vieja | ChatGPT: actualizar o recrear el conector. Codex y Claude Code: sesión nueva |
| `NETWORK_ERROR` | Red, DNS o Campus caído | Reintentar más tarde. No es una lista vacía |

Para revisar el estado local: `campus auth status --profile udesa-docente --verify` y `campus auth web status --profile udesa-docente --verify`. En el remoto, los logs: `vercel logs --environment production --since 30m` (no tienen tokens ni contenido).

## Renovar el token móvil

Cuándo: `AUTH_REQUIRED` generalizado, o después de una revocación.

1. Login local, con contraseña o con Google ([LOGIN_GOOGLE.md](LOGIN_GOOGLE.md)):

   ```bash
   node build/cli.js auth login --profile udesa-docente --method native
   ```

2. Si usás el remoto, publicá el token y redesplegá:

   ```bash
   node build/cli.js remote push-token --profile udesa-docente
   ```

   ```bash
   vercel deploy --prod
   ```

Moodle suele devolver **el mismo** token si el anterior sigue vigente. En ese caso el remoto no necesita cambios. `push-token` valida el token contra Moodle antes de subirlo.

## Renovar la sesión web

Cuándo: `AUTH_REQUIRED` sólo en las lecturas web. La sesión web vence tras **4 horas sin uso** (medido en UdeSA) o cuando cerrás sesión en el navegador de donde salió la cookie. El error del MCP local trae en `details.recovery.command` el comando exacto para esa PC.

Hay dos caminos (ADR-142, decisión del dueño):

1. **Login web automático (recomendado).** El MCP inicia sesión solo cuando la sesión vence; sólo hace falta renovar la confianza del dispositivo una vez por mes, con el código del correo. Puesta en marcha y renovación: [Login web automático en la PC](#login-web-automático-en-la-pc-recomendado).
2. **Importar la cookie (respaldo).** Para quien no quiere guardar la contraseña. Hay que repetirlo cada vez que la sesión vence.

### Importar la cookie (respaldo)

1. Abrí el Campus con tu cuenta. Conviene una ventana o un perfil de Chrome aparte, que no uses para navegar. Al terminar, cerrá la ventana **sin** «Cerrar sesión»: cerrar sesión invalida la cookie. Con `--open`, la CLI abre el Campus por vos.
2. F12 → Application → Cookies → `https://campusvirtual.udesa.edu.ar` → copiá el **Value** de `MoodleSession`.
3. Importala. Con `--clipboard`, la CLI la toma del portapapeles y después lo vacía (también si falla). Sin `--clipboard`, la entrada es oculta. En los dos casos comprueba que el Campus la acepte y que sea tu cuenta, y nunca muestra el valor:

   ```bash
   node build/cli.js auth web import --profile udesa-docente --clipboard
   ```

- **Historial del portapapeles:** vaciar el portapapeles no borra el historial de Windows (Win+V) ni su sincronización en la nube. Si los tenés activos, borrá esa entrada a mano o usá la entrada oculta (sin `--clipboard`).
- **Vencimiento estimado:** `auth web status` y `campus_get_status` muestran el último uso y a qué hora vence aproximadamente si nadie la usa. Es una estimación: el límite medido por `auth web status --verify` o, si no hay medición, las 4 h documentadas. `campus_get_status` con `verify_web` informa el tiempo real que queda (`time_remaining_s`).

La sesión importada es sólo del MCP local. El remoto tiene su propia sesión y su propia confianza, que se renuevan desde su panel ([login web automático en el remoto](#login-web-automático-en-el-remoto)); `remote push-web-session` quedó retirado (ADR-141).

## Mantener viva la sesión web

Cada uso renueva el plazo de 4 horas. `keepalive` hace una sola lectura (la página de identidad) y mide cuánto falta:

```bash
node build/cli.js auth web keepalive --profile udesa-docente
```

Para no depender de acordarte, una **tarea programada de Windows** puede correrlo sola cada 30 minutos (cambialo con `--every <min>`) y al iniciar sesión. Se crea sólo para tu usuario, sin administrador y sin ventana:

```bash
node build/cli.js auth web keepalive install --profile udesa-docente
```

- Ver si está instalada y cómo salió la última ejecución: `auth web keepalive status --profile udesa-docente` (o `auth web status --profile udesa-docente`). Si el último chequeo tiene más de dos intervalos, lo marca viejo: la tarea no está corriendo.
- Quitarla: `auth web keepalive uninstall --profile udesa-docente`.
- Corre sólo con tu sesión de Windows iniciada y la PC encendida. Si la PC queda apagada o suspendida más de 4 horas, la sesión vence igual: [renovala](#renovar-la-sesión-web).
- Si movés el proyecto o cambia la instalación de Node, `status` lo avisa: reinstalala. Si usás `--profile-file` o un directorio de estado propio (`--state-dir` o `CAMPUS_STATE_DIR`), instalala con los mismos: la tarea los repite (ADR-106).
- Una sesión que no vence alarga la exposición si la cookie se filtra. El corte de emergencia es el mismo: [Cerrar sesión en el navegador de origen](#cookie-de-sesión-web-expuesta).
- **En PCs administradas (cuenta de dominio, sin administrador, con antivirus corporativo) la tarea puede no funcionar:** `conhost --headless` puede terminar sin lanzar Node, y una variante con `wscript.exe` puede desaparecer por el antivirus (ADR-087). Si en tu PC no podés programar tareas, la alternativa es el [login web automático](#login-web-automático-en-la-pc-recomendado).

## Login web automático en la PC (recomendado)

Es el **método recomendado** para la sesión web en la PC (ADR-142, decisión del dueño; antes era opcional y no recomendado, ADR-088). Guarda tu contraseña del Campus en el Administrador de credenciales, y con ella el **MCP local** inicia sesión en la web solo cuando la sesión venció. Para el remoto (Vercel): [Login web automático en el remoto](#login-web-automático-en-el-remoto).

La sesión, la confianza del dispositivo, los intentos y las renovaciones viven en **un** registro de esta PC (`web-connection.json` en el directorio del perfil, cifrado con la clave `…|web_connection_box` del Administrador de credenciales). Lo comparten todos los procesos locales (`serve`, `serve-full`, la CLI y la tarea de keepalive): dos procesos con la sesión vencida hacen **un** solo login. Es el mismo modelo que el remoto (ADR-141).

1. **Puesta en marcha**, una vez, en tu terminal. Pide usuario, contraseña y el código que el Campus te manda al correo. La PC queda como **dispositivo de confianza** (en UdeSA, 28 días):

   ```bash
   node build/cli.js auth web autologin enable --profile udesa-docente
   ```

2. **Segunda llave:** agregá `CAMPUS_WEB_AUTOLOGIN=true` a la entrada del cliente MCP (`udesa-campus` y, si la usás, `udesa-campus-completo`) y abrí una sesión nueva. Sin la variable, los servidores no usan la contraseña.
3. **Uso:**
   - Cuando una herramienta necesita la sesión web y está vencida, el servidor inicia sesión solo y sigue.
   - Cuando vence la confianza del dispositivo, abre un **diálogo de Windows** para el código del correo. No lo escribas en el chat.
   - Si el diálogo no abre, la herramienta devuelve `AUTH_REQUIRED` con el comando del panel local: renová con el paso 4.

4. **Renovar la confianza (cada ~28 días, o antes):** el panel de conexión de esta PC.

   ```bash
   node build/cli.js auth web panel --profile udesa-docente
   ```

   - Abre tu navegador en `http://127.0.0.1:<puerto>/<secreto>/conexion`. Sólo responde en esta PC; el secreto de la dirección es la llave mientras está abierto: no lo compartas.
   - Los pasos son los del remoto: «Enviar código y renovar», escribir el código del correo en el panel y «Confirmar y verificar». Termina con una comprobación automática.
   - El panel **nunca pide la contraseña**: si no hay login automático, muestra el comando de la terminal.
   - Se cierra solo después de una renovación verificada, a los 15 minutos sin uso o con Ctrl+C. Con `--no-open` sólo muestra el enlace.
   - También se puede renovar desde la terminal, repitiendo el paso 1.

**Estado, vencimiento de la confianza e intentos:** `auth web autologin status --profile udesa-docente`, o `campus_get_status` (`connection`, con `mode: "local"`). El aviso llega 7 días antes del vencimiento.

### Síntomas por capa en la PC

| `campus_get_status` → `connection` | Qué pasa | Qué hacer |
|---|---|---|
| `method: "none"`, `action.kind: enable_local_autologin` | La PC no tiene sesión web ni login automático | `auth web autologin enable` (recomendado) o, como respaldo, `auth web import --clipboard` |
| `method: "cookie"`, `web_session.estimated_expires_if_idle_at` cerca | Cookie importada a punto de vencer por inactividad | Usarla o activar el login automático para no reimportarla |
| `device_trust.state: expiring` o `expired`, `action.kind: renew_local_trust` | La confianza del dispositivo vence o venció | `auth web panel` (o el diálogo, si lo ofrece el servidor) |
| `renewal.state: uncertain`, `action.kind: review_attempt` | Un intento quedó sin resultado confirmado | Revisá Sesiones del navegador en el Campus; el panel ofrece «Iniciar otra renovación». Nunca se reenvía solo |
| `persistence.state: failed` (`kv_unavailable`) | El archivo de la conexión está dañado o tomado | No se pisa solo. Revisá `web-connection.json`; para empezar de cero, movelo de lugar y repetí `auth web autologin enable` |
| `persistence.state: failed` (`config_conflict`) | Se perdió la clave de cifrado del Administrador de credenciales | Repetí `auth web autologin enable` |

**Guardas:**
- Si el Campus rechaza la contraseña o el código, el login automático se **desactiva**. Nunca reintenta, porque cada fallo suma al bloqueo de la cuenta.
- Pausa de 10 minutos después de un intento fallido y de 2 minutos después de uno exitoso; a lo sumo 6 intentos en 24 horas, contando juntos el panel, la terminal y todos los procesos de la PC.
- Si aparece un captcha, otro factor, un cambio de contraseña forzado o políticas pendientes, se detiene y lo dice.

**Registro:** cada login queda registrado en el Campus (evento de inicio de sesión y último acceso).

**Desactivarlo:** `auth web autologin disable --profile udesa-docente` borra la contraseña y la confianza. La sesión abierta sigue hasta que vence.

**Migración (una sola vez):** la primera vez que corre la versión con ADR-142, adopta la cookie y la confianza del keyring y el estado de `web-autologin.json` sin iniciar sesión; el archivo viejo queda como `web-autologin.json.migrated`. Para volver a una versión anterior: renombrarlo de nuevo a `web-autologin.json` y repetir `enable`. Después de actualizar, reiniciá los clientes MCP para que ningún servidor viejo siga escribiendo el estado anterior.

**Correos con código:** cuando el MCP necesita el código, te llega el correo de siempre. Escribí el código en el panel, en el diálogo o en la terminal con `enable`. **No uses el enlace del correo para avisar que no fuiste vos:** revoca el factor correo de toda la cuenta, cierra todas tus sesiones y puede suspender la cuenta. Usalo sólo si de verdad no fuiste vos.

**Cambiar la contraseña del Campus** con el login automático activo: primero `auth web autologin disable` en cada computadora donde esté activo y `remote autologin disable` + deploy si está en el remoto; después cambiala; después `enable` de nuevo en cada lugar. Así no se juntan rechazos que acerquen la cuenta al bloqueo.

## Login web automático en el remoto

Con esto, el servidor de Vercel (ChatGPT, Codex o Claude remotos) inicia sesión en la web solo cuando la sesión venció, con un dispositivo de confianza propio del remoto (ADR-127). Desde ADR-141, la **renovación mensual se hace en el navegador**, en el panel privado del servidor, sin la PC ni un redeploy.

### Renovar la conexión (lo habitual, cada ~28 días)

1. Abrí **`https://<tu-proyecto>.vercel.app/admin/conexion`**. Pide tu GitHub (el mismo de la página de aprobación). Abrirlo no inicia sesión en el Campus ni manda correos.
2. Apretá **«Enviar código y renovar»**. El servidor inicia sesión en el Campus y el Campus te manda un código al correo institucional (no uses el enlace «no fui yo» del correo).
3. Escribí el código de seis dígitos **en el panel** (nunca en el chat) y apretá **«Confirmar y verificar»**. El panel publica la sesión y la confianza nuevas y comprueba solo la API, la sesión web, la identidad y la confianza. Termina con «Conexión renovada y verificada» o dice qué capa falló.
4. Desde el chat, el agente lo confirma con `campus_get_status({verify: true, verify_web: true})`.

El panel muestra hasta cuándo vale la confianza, en hora de Argentina, y cuánto falta. `campus_get_status` avisa desde **7 días antes** (`connection.device_trust.state = "expiring"` y `web_autologin.action_needed`), con el enlace al panel en `connection.action`.

**Si algo no sale:**
- **«No recibí el código»:** revisá spam y esperá un par de minutos. Si no llega, «Cancelar» y volvé a iniciar cuando termine la pausa (10 minutos después de un intento fallido; 2 minutos después de uno correcto).
- **«El Campus no aceptó el código»:** puede ser incorrecto o haber vencido (vale 10 minutos). Iniciá otra renovación cuando termine la pausa.
- **«No pudimos confirmar el resultado del intento»:** hubo un corte justo después de enviar la contraseña o el código. El servidor **no reenvía nada solo**. Revisá tus [sesiones del navegador](https://campusvirtual.udesa.edu.ar/report/usersessions/user.php) y, si querés, apretá «Iniciar otra renovación».
- **«La renovación quedó guardada. No pudimos comprobar la conexión»:** la renovación está publicada; repetí sólo «Comprobar conexión» (no pide otro código).
- **Límites:** hasta 6 intentos por día, compartidos con el login automático; el panel dice desde qué hora se puede volver a intentar.
- Contraseña rechazada, configuración incompleta o en conflicto, token de la API inválido u otra cuenta: el panel no lo puede resolver y pide la recuperación desde la PC (abajo).

### Síntomas por capa

`campus_get_status` en el remoto devuelve `connection` con una capa por credencial y la fecha de su evidencia:

| Capa | Qué es | Si falla |
|---|---|---|
| `api_token` | Token móvil de Moodle (`CAMPUS_MOODLE_TOKEN`) | [Renovar el token móvil](#renovar-el-token-móvil) y `remote push-token` + deploy |
| `web_session` | Sesión web publicada en el KV | La renueva el login automático; si no puede, el panel |
| `device_trust` | Confianza del dispositivo del remoto (28 días) | Panel (`renew_web_trust`) |
| `persistence` | Registro cifrado de la conexión en el KV | Esperar; si sigue, recuperación desde la PC |
| `renewal` / `activation` | Renovación en curso o recuperación pendiente de activar | Esperar o «Activar y verificar recuperación» en el panel |

Un `AUTH_REQUIRED` de la sesión web trae `details.recovery.kind`: `renew_web_trust` o `activate_recovery` (abrir el panel, con la URL en `details.recovery.url`), `review_attempt` (intento incierto: revisar antes de rearmar), `wait` (renovación en curso, pausa o KV) o `cli_recovery` (recuperación desde la PC).

**Uso:** cuando una herramienta remota necesita la sesión web y está vencida, el servidor inicia sesión solo, sin código, mientras la confianza esté vigente. Las guardas son las mismas que en el local: un rechazo de contraseña lo desactiva, y hay pausas y un máximo de 6 intentos por día.

### Recuperación desde la PC (CLI, ADR-141)

La renovación habitual de la conexión web del remoto se hace desde el panel privado `/admin/conexion`. Si el panel no responde o la configuración del servidor quedó inutilizable, la recuperación excepcional se corre en la PC con `node build/cli.js remote autologin renew --profile udesa-docente --redeploy` (opcional: `--base-url https://<tu-remoto>` o la variable `CAMPUS_REMOTE_URL` para que el comando muestre el enlace exacto al panel). El comando primero revisa la terminal, el build, el vínculo con Vercel (`.vercel/project.json`) y la CLI `vercel`; usa la contraseña del Campus guardada en el keyring y, si no está, la pide en la terminal (oculta) sin exigir el login automático local ni guardarla. Hace UN solo login aislado como dispositivo «remoto», sin la confianza de la PC, así que el Campus manda un código al correo (no uses el enlace «no fui yo»). Antes de publicar valida la cuenta esperada y que la cookie de confianza `MFA_TOKEN_<userid>` tenga un vencimiento real con más de un día de margen. Si todo da bien, publica una sola variable sensible, `CAMPUS_WEB_BOOTSTRAP` (sobre v2 con credenciales, confianza, sesión y un `activation_epoch` monotónico), más `CAMPUS_WEB_AUTOLOGIN=true` como segunda llave, y borra las variables legacy `CAMPUS_WEB_LOGIN`, `CAMPUS_WEB_TRUST` y `CAMPUS_WEB_SESSION`. Los estados se informan por nombre y sin exagerar: `candidate_validated`, después `configuration_published_pending_deploy` (sin `--redeploy` todavía falta correr `vercel deploy --prod`) y por último `deployed_pending_verification`. La CLI nunca dice «verificado»: para eso hay que abrir `/admin/conexion` en el remoto y apretar «Activar y verificar recuperación», o usar `campus_get_status {verify: true, verify_web: true}` desde el conector MCP. Conviene hacerlo enseguida, porque la sesión publicada puede vencer por inactividad. Si el deploy falla, la configuración queda publicada pero sin desplegar, y `remote autologin deploy` repite sólo el deploy, sin pedir otro código. Si falla una carga en Vercel, en esa misma corrida se puede reintentar la publicación con la misma candidata (misma sesión, mismo epoch) sin otro código. La candidata vive sólo en memoria: si corrés el comando de nuevo, hay un login y un código nuevos. `remote autologin disable [--redeploy]` publica el sobre `{mode: "disabled"}` con un epoch mayor, deja `CAMPUS_WEB_AUTOLOGIN=false` y borra las variables legacy; la sesión abierta en el remoto sigue hasta que vence. `remote autologin status` muestra sólo el historial de publicación de esta PC (`remote-autologin.json`: epochs, fechas, vencimiento de la confianza y estado, sin secretos) y avisa cuando faltan menos de 7 días. El estado real de producción se consulta en el panel o con `campus_get_status`. Si el diagnóstico del remoto rechaza el epoch porque el reloj de la PC está atrasado, repetí `renew` con `--min-epoch <epoch aceptado>`. `remote push-web-session` quedó retirado: el remoto v2 ignora `CAMPUS_WEB_SESSION`, así que el comando se niega y explica qué usar en su lugar.

**Reconocer la sesión del remoto:** en [Sesiones del navegador](https://campusvirtual.udesa.edu.ar/report/usersessions/user.php) (no tiene enlace en Preferencias), es la que tiene como última IP una de Amazon (San Pablo). La página no muestra el navegador.

**Desactivarlo:** `node build/cli.js remote autologin disable --profile udesa-docente --redeploy`. La sesión que el remoto tenga abierta sigue hasta que vence; para cortarla antes, «Cerrar sesión» en su fila de Sesiones del navegador.

**Corte de emergencia:** cambiar la contraseña del Campus, que cierra todas las sesiones. Para cortar sólo la sesión del MCP: Preferencias → Sesiones del navegador (`report/usersessions/user.php`) → «Cerrar sesión» en su fila. Ahí ves todas tus sesiones con su IP y último acceso. Cambiar la contraseña no revoca los dispositivos de confianza: fijate si tu sitio permite revocarlos desde las preferencias del MFA.

## Publicar un cambio de código

1. `npm run build` y `npm test`, sin fallas.
2. Actualizá la documentación que corresponda ([checklist](#agregar-una-lectura-nueva)).
3. Hacé commit y push a `main`.
4. Si tu proyecto de Vercel no está conectado por Git, desplegá con `vercel deploy --prod`.
5. Comprobá que `https://<tu-proyecto>.vercel.app/health` responda `ok:true`.
6. Si cambió la lista de herramientas, refrescala en los clientes (ver [Diagnóstico rápido](#diagnóstico-rápido)). El MCP local de Claude Code toma el build nuevo en la próxima sesión.

## Incidentes

### Token móvil expuesto

Pasa, por ejemplo, si el enlace `udesacampusmcp://token=…` terminó en un chat, una captura, un documento o la barra del navegador.

1. **UdeSA no ofrece «Claves de seguridad»** (`/user/managetoken.php` responde 404), así que no podés restablecerlo vos. Pedí a la mesa de ayuda que revoque el token del servicio «Moodle mobile web service» de tu cuenta. Un login nuevo devuelve el mismo token mientras siga vigente: no sirve como rotación.
2. Cuando lo revoquen, [renová el token móvil](#renovar-el-token-móvil), con el paso del remoto incluido.
3. Borrá el rastro: el historial del navegador y, si fue una búsqueda, la actividad en «Mi actividad» de Google.

Mientras tanto, el riesgo es el de cualquier token de la app móvil: lectura y escritura en tu cuenta para quien lo tenga. El servidor de lectura no escribe, pero el token sí podría. Es un riesgo aceptado como decisión de diseño (ADR-048) y no frena las escrituras. Si querés cortarlas igual: `campus write disable --profile docente-completo` en local y, en el remoto, quitar `CAMPUS_WRITE_ENABLED` y redesplegar ([Escrituras](#escrituras)).

### Cookie de sesión web expuesta

1. En el navegador de donde salió, tocá **Cerrar sesión** en el Campus. Eso destruye la sesión del lado del servidor y la cookie deja de servir en todos lados, Vercel incluido.
2. Si querés seguir usando las lecturas web, [renová la sesión web](#renovar-la-sesión-web) con una cookie nueva.

### Cortar el acceso remoto

- **Desconectar todos los clientes:** `campus remote init-secret --profile udesa-docente` + `vercel deploy --prod`.
- **Quitarle el Campus al remoto:** `remote autologin disable --redeploy` (corta la conexión web) y borrar `CAMPUS_MOODLE_TOKEN` con `vercel env rm … production` y redesplegar.
- **Cortar sólo las escrituras remotas:** cambiar `CAMPUS_WRITE_TOKEN_VERSION` (revoca los tokens de `/mcp-completo` y `/mcp-escritura`) o quitar `CAMPUS_WRITE_ENABLED`, y redesplegar.
- **Cortar todo:** además, borrar la OAuth App de GitHub o pausar el proyecto en Vercel.

## Agregar una lectura nueva

Hacé las mismas comprobaciones en el mismo orden para cada lectura nueva. Ninguna lectura entra sin la auditoría de efectos.

1. **Necesidad y fuente.** Elegí la función del servicio móvil (`core_webservice_get_site_info` muestra cuáles se anuncian) o una superficie web de la cuenta docente. No se agregan herramientas genéricas de `wsfunction`, AJAX ni URL.
2. **Auditoría de efectos contra el código de Moodle 5.1** (la versión del Campus). Revisá si escribe algo: si marca como leído o visto, si recalcula, crea categorías, guarda caché o preferencias, o registra eventos. Excluidas siempre: `*_view_*`, `tool_mobile_get_autologin_key`, los tokens QR, los tokens de exportación de calendario y las páginas de edición. Si tiene efectos, queda bloqueada, salvo una excepción explícita de quien despliega, que se registra como ADR (por ejemplo, ADR-031). No pruebes una escritura para «ver qué pasa».
3. **Política.** Agregala a la allowlist que corresponda: `src/moodle/functions.ts` (REST, con política de parámetros si hace falta) o `src/web/policy.ts` (rutas web y métodos AJAX, con parámetros cerrados). Verificá el alcance antes de la red: curso permitido → actividad del curso → participante matriculado. Si la lectura trae datos de terceros (entregas, notas ajenas, participantes, intentos, reportes…), exigí además rol docente o superior en ese curso (`assertTeacherCourse`, ADR-122); lo propio se lee con cualquier rol.
4. **Esquema de proyección** (`src/moodle/schemas.ts`). Proyectá sólo los campos que la herramienta usa. Los datos personales (email, legajo, nombre…) entran si la operación los necesita, marcados con 👤 en HERRAMIENTAS (ADR-124). Nunca credenciales ni secretos: contraseñas, claves de inscripción, tokens, `userprivateaccesskey`, `username`. Lo que se guarda en disco (metadata de sesión, reporte de capacidades, logs) no lleva datos personales. Un formato desconocido es `UNEXPECTED_RESPONSE`, nunca un vacío.
5. **Dominio y herramienta.** Implementá la lectura en `src/domain/` y la herramienta tipada en `src/mcp/server.ts`. La respuesta lleva `source` (con `adapter` y `operation` si no es REST), `coverage` (y `coverage.detail` para lo desconocido u omitido) y `warnings`.
6. **Tests con datos sintéticos** (`tests/fixtures/`): caso feliz, fuera de alcance sin red, error explícito (sin vacíos) y un espía de red que pruebe que no se emiten rutas o parámetros prohibidos. Nunca uses datos reales de estudiantes en fixtures.
7. **Documentación:**
   - la fila en [HERRAMIENTAS.md](HERRAMIENTAS.md), en su área, junto con la tabla de efectos auditados;
   - un ADR en [DECISIONES.md](DECISIONES.md);
   - el catálogo en HERRAMIENTAS.md (los demás documentos enlazan ahí, sin repetir totales).
8. **Validación real** (ver abajo), y después [publicá el cambio](#publicar-un-cambio-de-código).

## Validar en real

1. Usá el perfil `udesa-docente`. **Entorno de pruebas: tu curso de pruebas (sandbox)**, uno que pedís a Campus Virtual con escritura libre (ADR-043). Ahí se arman los casos que faltan (reglas aleatorias, rúbricas, overrides, prórrogas, grupos separados) y se prueban las escrituras. En los cursos con estudiantes reales se valida leyendo. Lo propio con rol de estudiante se valida en un curso donde la cuenta es estudiante. Antes de una prueba web, verificá la sesión con `auth web status --verify`.
2. Anotá **sólo totales y estructura** («28 participantes, 10 con acciones»). Nunca copies nombres, notas, respuestas ni contenido de estudiantes al repositorio.
3. Si es posible, compará con la vista del Campus. Registrá lo que se emitió: qué funciones o rutas se llamaron, y que ninguna prohibida.
4. Si la lectura sirve en remoto, probala desde un cliente después del deploy.

## Escrituras

Las intenciones de escritura están en [HERRAMIENTAS.md](HERRAMIENTAS.md#escrituras), y lo que se puede crear, editar y borrar en cada tipo de elemento, en [SANDBOX_ELEMENTOS.md](SANDBOX_ELEMENTOS.md). Funcionan en local y en remoto (`/mcp-completo` y `/mcp-escritura`, ADR-060). Diseño: ADR-044 en adelante.

Reglas del perfil `udesa-docente-escritura`:
- **Dónde:** en cualquier curso donde tu rol sea de profesor, gestor o superior (`editingteacher`, `manager` o `coursecreator`), con las capacidades de `write_policy.all_courses` (ADR-122 y ADR-125). El rol se verifica en vivo antes de armar cada plan; con otro rol, `POLICY_DENIED`.
- **Aprobación:** ningún plan pide aprobación fuera del chat, ni en local ni en remoto (`require_out_of_band_from_risk: "nunca"`, ADR-061). Los planes R3 y R4 exigen al **humano en el circuito** (ADR-118): el agente le plantea la acción al usuario y ejecuta sólo con su aprobación explícita, que pasa textual en `user_approval` y queda en la auditoría. Si el cliente local admite elicitación, el servidor se lo pregunta directamente.
- **Riesgo:** lo calcula el servidor a partir del de la intención. Sube un nivel con más de 5 ítems en un plan R2 y con más de un mensaje (ADR-126).
- **Notificaciones a participantes** (`allow_participant_notifications`, ADR-130). En el perfil de ejemplo están permitidas: se puede publicar en Avisos y en otros foros con suscripción forzada. Fuera del sandbox, un aviso o una respuesta ahí son R3, así que el agente te muestra el plan y espera tu aprobación explícita antes de publicar. Las calificaciones de tareas y foros solicitan aviso por defecto (`notify_students_default: true`); `notify_student: false` lo desactiva por plan, y los mensajes privados son R3, de a uno. En el sandbox, las pruebas van a un foro de prueba con suscripción opcional. Con `false`, el plan rechaza toda escritura que mande correo a participantes, salvo a las cuentas de prueba del sandbox si las cargaste (`notifiable_user_ids`, ver abajo, ADR-120); aprobar una entrada de glosario puede avisar a su autor (ADR-089).
- **Límites del perfil:** 2000 escrituras y 20 mensajes por día; 30 ítems y 1 mensaje por plan.

**Sandbox y cuentas de prueba.** El perfil publicado trae `sandbox_course_ids: []` y `notifiable_user_ids: []`: completalos con los tuyos en `profiles/udesa-docente-escritura.json`.
- El ID de tu curso de pruebas está en su URL: `course/view.php?id=<ID>`. Va en `sandbox_course_ids`.
- El ID de cada cuenta de prueba está en la URL de su perfil: `user/profile.php?id=<ID>`. Van en `notifiable_user_ids`.
- Los mensajes privados y los avisos de calificación sólo llegan a esas cuentas y sólo en esos cursos. Con las listas vacías, ninguna escritura notifica a nadie.
- `sandbox_confirmation: "cliente"` sólo vale en los cursos de `sandbox_course_ids`.

Crear tareas usa la sesión web: verificala antes con `auth web status --verify`.

En los comandos de esta sección, `--profile` es el perfil de **escritura**: `udesa-docente-escritura`. Ese perfil usa el token, la sesión web y la identidad del perfil de lectura `udesa-docente`: no hay un login aparte.

### Cómo funciona una escritura

1. El agente arma un plan con `campus_plan_<intención>`. Es una lectura: no escribe y el plan vence a los 15 minutos.
2. El agente lo ejecuta con `campus_execute_plan(plan_id)`.
3. No hay aprobación fuera del chat (ADR-061): el plan lo declara en `risk_reasons` y se ejecuta. Si es R3 o R4, trae `human_in_the_loop.present_to_user`: el agente se lo plantea al usuario y, si aprueba, ejecuta con `user_approval` (ADR-118). Sin eso, `CONFIRMATION_REQUIRED` y no se escribe nada. Si el perfil fija un umbral (`R1` o `R2`), en local se abre un **diálogo de Windows** con el plan y el código de 6 caracteres (o se aprueba con `write approve`), y en remoto, la página `/aprobar/<plan_id>`. En el sandbox, con `sandbox_confirmation: "cliente"`, la confirmación queda en el cliente aunque haya umbral (ADR-048).
4. El servidor ejecuta, relee y devuelve `aplicado_verificado`, el único éxito pleno, o `aplicado_con_diferencias`, con campo, esperado y obtenido. Cualquier otro desenlace llega como error (`VERIFICATION_FAILED`, `MOODLE_REJECTED` o `PARTIAL_APPLIED`): no es un éxito.

### Aprobar desde la terminal (sólo si el perfil fija un umbral)

Con `"nunca"` no se usa. Con un umbral, si el diálogo no aparece o vence, el agente recibe `CONFIRMATION_REQUIRED`. Aprobá desde tu terminal:

```bash
node build/cli.js write pending --profile udesa-docente-escritura
```

```bash
node build/cli.js write approve <plan_id> --profile udesa-docente-escritura
```

`approve` muestra el plan y pide que tipees su código. Aprobar ejecuta el plan en ese momento y muestra el resultado. Nunca le dictes el código al agente: la confirmación es tuya.

### Deshacer

Pedile al agente `campus_undo_action(action_id)`. Arma un plan de deshacer, que se ejecuta con `campus_execute_plan` como cualquier escritura. Cada plan dice qué tipo de deshacer tiene y hasta cuándo vale. Por ejemplo, un aviso borrado dentro de los 5 minutos de publicado (maxeditingtime de UdeSA, ADR-100) no manda el correo; un mensaje privado no se puede deshacer.

### Deshabilitar, reanudar y auditar

| Para | Comando |
|---|---|
| Cortar todas las escrituras al instante (las lecturas siguen) | `node build/cli.js write disable --profile udesa-docente-escritura` |
| Volver a habilitarlas (pide escribir HABILITAR; requiere terminal) | `node build/cli.js write enable --profile udesa-docente-escritura` |
| Reanudar antes de tiempo después del freno (pide escribir REANUDAR) | `node build/cli.js write resume --profile udesa-docente-escritura` |
| Ver qué se escribió | `node build/cli.js write log --profile udesa-docente-escritura --since <AAAA-MM-DD>` |
| Estado, límites del día y capacidades (por curso y `all_courses`) | `node build/cli.js write status --profile udesa-docente-escritura` |

Estos comandos actúan sobre el estado **local** (`%LOCALAPPDATA%\udesa-campus-mcp\…`): `write resume` no destraba el remoto. Las escrituras remotas (`/mcp-completo`, `/mcp-escritura`) guardan planes, interruptor, límites y auditoría en el KV de Upstash: para cortarlas, cambiá `CAMPUS_WRITE_TOKEN_VERSION` o quitá `CAMPUS_WRITE_ENABLED` en Vercel y redesplegá ([CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md#escrituras-remotas)).

### Freno ante fallos (ADR-134)

Tres fallos **distintos** (`sin_efecto` o `rechazado_por_moodle`) en 15 minutos pausan las escrituras durante **2 horas**. Las lecturas siguen. El error `WRITE_DISABLED` trae `reason=automatic_cooldown`, la hora de reapertura en la zona del perfil y `retry_after_seconds`; `campus_get_write_status` muestra lo mismo en `brake`.

- **Repetir el mismo intento fallido no cuenta de nuevo.** Tres rechazos del mismo archivo contra el mismo recurso cuentan como uno. Los errores previos a escribir (plan obsoleto o vencido, confirmación pendiente, política) no cuentan.
- **Recuperación automática:** pasadas las 2 horas, la primera ejecución es una **prueba**. Si queda `aplicado_verificado`, el freno se cierra; con cualquier otro resultado, otra pausa de 2 horas. Mientras la prueba corre, las demás ejecuciones reciben `reason=probe_in_progress` sin escribir. La pausa nunca vuelve a ejecutar planes viejos.
- **Recuperación administrativa (antes de las 2 horas):** en local, `write resume` (arriba). En el remoto, el panel **`/admin/escrituras`** ([REMOTO_VERCEL.md](REMOTO_VERCEL.md#mantenimiento)). Las dos sólo liberan el freno: no tocan el interruptor manual (`write disable`/`enable`), que nunca vence solo, ni los límites del día.
- Ajustable por perfil en `write_policy.brake` (`failure_threshold`, `failure_window_seconds`, `cooldown_seconds`); sin la clave valen 3, 900 y 7200.

**Un PDF que Moodle rechaza en la subida** (`stage: upload_draft`, HTTP 403): el problema suele estar en el archivo. Regeneralo (por ejemplo, abrilo e imprimilo con «Microsoft Print to PDF») y pedí un plan nuevo con el archivo nuevo. No siempre alcanza, y el MCP nunca convierte el archivo por su cuenta.

- **Auditoría:** `%LOCALAPPDATA%\udesa-campus-mcp\profiles\udesa-docente-escritura\write-audit.jsonl`. Registra planes, confirmaciones, ejecuciones y deshaceres, sin tokens ni contenido de estudiantes; tus textos van como hash.
- **Planes:** quedan en `plans\` del mismo directorio. Sirven para auditar y para deshacer.

### Perfiles: docente-lectura y docente-completo (ADR-062)

| Perfil | Qué da | Local | Remoto |
|---|---|---|---|
| `docente-lectura` (alias de `udesa-docente`) | Todas las tools de lectura | `serve --profile docente-lectura` | `/mcp` |
| `docente-completo` (alias de `udesa-docente-escritura`) | Lecturas + escrituras en **un** conector | `serve-full --profile docente-completo` con `CAMPUS_WRITE_ENABLED=true` | `/mcp-completo` |

Un cliente que sólo lee usa `docente-lectura`. Uno que también escribe usa **sólo** `docente-completo`; si conectás los dos, las tools de lectura se duplican.

```json
"udesa-campus-completo": {
  "command": "node",
  "args": ["<ruta>/udesa-mcp/build/cli.js", "serve-full", "--profile", "docente-completo"],
  "env": { "CAMPUS_WRITE_ENABLED": "true" }
}
```

Los ids internos (`udesa-docente`, `udesa-docente-escritura`) valen como alias, porque el keyring y el estado local están guardados con ellos. Los comandos `auth`, `write` y demás aceptan cualquiera de los dos nombres.

### Conectar sólo el servidor de escritura

Opcional: lo recomendado es `udesa-campus-completo` (arriba). Es **otra entrada** del cliente MCP, distinta de `udesa-campus`, y necesita las dos llaves: el perfil de escritura y la variable `CAMPUS_WRITE_ENABLED=true` en esa entrada.

```json
"udesa-campus-escritura": {
  "command": "node",
  "args": ["<ruta>/udesa-mcp/build/cli.js", "serve-write", "--profile", "udesa-docente-escritura"],
  "env": { "CAMPUS_WRITE_ENABLED": "true" }
}
```

Sin la variable, el servidor no arranca (`WRITE_DISABLED`).

### Probar avisos en un foro con suscripción forzada

La guarda de notificaciones lo bloquea. Este procedimiento sirve si alguna vez se habilitan notificaciones para un foro forzado, y se hace sólo en tu curso de pruebas (sandbox).

El foro de Avisos del sandbox tiene **suscripción forzada**: un aviso les llega por correo a sus participantes si no se borra antes de `maxeditingtime`. En Moodle ese valor es de 30 minutos por defecto; **en UdeSA es de unos 5 minutos** (ADR-100).

1. Conectá la entrada `udesa-campus-completo` (arriba) y abrí una sesión nueva del cliente.
2. Pedile al agente un aviso de prueba en el sandbox. Revisá el plan: el foro, la suscripción, los posibles destinatarios y el HTML.
3. Ejecutalo y esperá `aplicado_verificado`.
4. **Enseguida, dentro del primer minuto,** pedile `campus_undo_action` con el `action_id` y ejecutalo. Tiene que volver `aplicado_verificado`, con la discusión borrada.
5. Anotá los tiempos y si llegó algún correo a las cuentas de prueba.
6. Repetí con una respuesta en una discusión de prueba (y su borrado), con la edición de un post propio, y con fijar y bloquear (R1, sin correo).

Para que no salga ningún correo, la alternativa más segura es hacer las pruebas en un foro de prueba con suscripción opcional (nadie queda suscripto por defecto, ADR-098), con su `forum_id`.

### Programar un aviso o mandarlo sin demora (ADR-143)

- **Programar:** pedile al agente el aviso con `display_start` (y, si querés, `display_end`) en tu hora local, por ejemplo «2026-12-01T08:00». El plan muestra la hora local y el instante UTC. Los estudiantes no ven la discusión hasta esa hora, y Moodle no manda el correo antes.
- **Cambiar o quitar el período después:** `campus_plan_forum_display_period` sobre una discusión tuya. Ausente conserva ese extremo y `null` lo quita.
- **Sin demora:** `notify_without_edit_delay: true`. Moodle procesa el correo en el próximo cron, sin la ventana de edición. Es **irreversible**: borrar después no lo retira de los buzones. El plan es R3: el agente te lo presenta y espera tu aprobación en el chat.
- Las dos opciones van por el formulario web del Campus y necesitan la sesión web. Si el formulario no las ofrece (timed posts deshabilitados en el sitio, o una cuenta sin permiso de `mailnow`), no se publica nada y el error lo dice.
- Programado + sin demora a la vez está bloqueado hasta validarlo en real.

### Habilitar una capacidad (sólo quien despliega)

1. La capacidad tiene que estar verificada en tu curso de pruebas (sandbox).
2. Para todos los cursos donde tu rol es de profesor, gestor o superior, agregala en `write_policy.all_courses` de `profiles/udesa-docente-escritura.json`. Para un curso puntual, en `write_policy.courses["<curso>"]`: esa entrada reemplaza a `all_courses` en ese curso, y con lista vacía lo bloquea. Una capacidad puede llevar la fecha en que se habilitó (`{"capability": "post_announcement", "enabled_on": "2026-11-02"}`); es sólo informativa.
3. Commit con el motivo. Ni el agente ni una variable de entorno pueden habilitar capacidades. El rol de escritura en el curso (`write_role_shortnames` del perfil de lectura) se exige aparte, siempre.

### Agregar una escritura nueva

Mismo criterio que [una lectura nueva](#agregar-una-lectura-nueva), con estos pasos extra:

1. Agregar la función a `WRITE_FUNCTIONS`, o la tupla a `WRITE_AJAX_METHODS` / `WRITE_WEB_FORMS` (`src/write/functions.ts`), con un validador cerrado.
2. Escribir la intención en `src/write/intents/`. Tiene que cubrir: plan con valores por defecto visibles, precondiciones, interpretación de fallas silenciosas, reconciliación ante error de red, verificación y deshacer.
3. Agregar tests con el Moodle sintético para cada trampa: fallas silenciosas (Moodle responde bien pero no aplica), error de red a mitad de camino (reconciliar releyendo), verificación por relectura y deshacer.
4. Hacer las pruebas reales en tu curso de pruebas (sandbox) antes de usarla en un curso real.
5. Documentar: ADR y HERRAMIENTAS.

## Otra computadora

Para **usar** el MCP desde otra computadora alcanza con conectar el cliente al remoto. Para **desarrollar o renovar credenciales** hay que clonar, compilar y vincular tu proyecto de Vercel. Las dos cosas están en [CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md).

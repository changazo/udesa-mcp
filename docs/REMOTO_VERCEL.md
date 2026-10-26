# Servidor remoto privado en Vercel

Un MCP remoto **sólo para vos**, desplegado en tu propio proyecto de Vercel: el servidor acepta una única cuenta de GitHub (`GITHUB_ALLOWED_USER_ID`). Sirve para usar el Campus desde ChatGPT web, Codex, Claude Code y claude.ai (sin probar) (ver [CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md)), con cualquier rol: lo tuyo en todos tus cursos y, donde sos docente o gestor, también los datos de otras personas y las escrituras. Mismo núcleo que el modo local:

- `/mcp` sirve sólo lectura con el perfil `docente-lectura` (`udesa-docente`): todos los cursos donde la cuenta está matriculada, con cualquier rol; los datos de terceros, sólo donde es docente o superior (ADR-122). La variable opcional `CAMPUS_PROFILE` elige otro perfil versionado.
- `/mcp-completo` (lecturas y escrituras, `docente-completo`) y `/mcp-escritura` (sólo escrituras) exigen el alcance `campus.write`, usan el KV de Upstash y admiten todos los riesgos; R3 y R4 con la aprobación del usuario en `user_approval` (ADR-060 a 062 y ADR-118). Escriben en los cursos donde el rol es de profesor, gestor o superior (ADR-125).

## Cómo funciona

```text
Cliente MCP ──► https://<dominio>/mcp            (Bearer: access token de ESTE servidor, 1 h)
     │  401 + WWW-Authenticate → descubre /.well-known/oauth-protected-resource/mcp
     ├─► POST /register        registro dinámico (sólo callbacks de claude.ai/claude.com, chatgpt.com y loopback)
     ├─► GET  /authorize       pantalla de consentimiento (PKCE S256 obligatorio)
     │        └─► GitHub OAuth → /oauth/github/callback → sólo pasa GITHUB_ALLOWED_USER_ID
     └─► POST /token           código (120 s) → access (1 h) + refresh (30 días)
/mcp ──► núcleo udesa-campus-mcp ──► Moodle con CAMPUS_MOODLE_TOKEN (variable sensible de Vercel)
/mcp-completo, /mcp-escritura ──► mismo OAuth con scope campus.write (token propio, revocable con CAMPUS_WRITE_TOKEN_VERSION) ──► motor de escritura + KV Upstash
/descarga/<token>/<nombre> ──► enlace temporal firmado (15 min, sin OAuth: el enlace es la credencial) ──► archivo de Moodle (ADR-113)
```

- **Sin base de datos para la lectura:** clientes, códigos y tokens son JWT firmados con `OAUTH_SIGNING_SECRET`. Rotar esa clave revoca todas las conexiones. Las escrituras usan Upstash Redis (KV) para planes, uso único, límites y auditoría.
- **Dos credenciales distintas:** el token OAuth de este servidor (lo ven los clientes) y el token de Moodle (sólo lo usa el servidor; nunca sale en respuestas ni logs).
- **Plan Hobby:** una función, región `gru1` (São Paulo), duración máxima configurada de 60 s. Uso personal y no comercial.

## Variables de entorno (production)

| Variable | Sensible | Cómo se carga |
|---|---|---|
| `PUBLIC_BASE_URL` | no | `campus remote configure` |
| `GITHUB_CLIENT_ID` | no | `campus remote configure` |
| `GITHUB_ALLOWED_USER_ID` | no | `campus remote configure` (el ID numérico de tu cuenta de GitHub) |
| `GITHUB_CLIENT_SECRET` | **sí** | vos, con `vercel env add … --sensitive` (pegás el valor) |
| `OAUTH_SIGNING_SECRET` | **sí** | `campus remote init-secret` (se genera y carga sin mostrarse) |
| `CAMPUS_MOODLE_TOKEN` | **sí** | `campus remote push-token` (del keyring a Vercel por stdin, validado antes) |
| `CAMPUS_EXPECTED_USERID` | no | `campus remote push-token` |
| `CAMPUS_WEB_SESSION` | **sí**, opcional | `campus remote push-web-session` o `campus remote autologin enable`: semilla de la sesión web (con el KV, la sesión vigente vive ahí; ADR-127) |
| `CAMPUS_WEB_AUTOLOGIN` | no, opcional | `campus remote autologin enable` → `true`: segunda llave del login web automático remoto (ADR-127) |
| `CAMPUS_WEB_LOGIN` | **sí**, opcional | `campus remote autologin enable` (la contraseña del keyring, por stdin; nunca se muestra) |
| `CAMPUS_WEB_TRUST` | **sí**, opcional | `campus remote autologin enable` (dispositivo de confianza propio del remoto; 28 días) |
| `CAMPUS_PROFILE` | no, opcional | perfil de lectura de `/mcp` (por defecto `udesa-docente`) |
| `CAMPUS_WRITE_ENABLED` | no | `vercel env add CAMPUS_WRITE_ENABLED production` → `true` (segunda llave de `/mcp-escritura` y `/mcp-completo`) |
| `KV_REST_API_URL` | no | la crea la integración Upstash Redis del Marketplace (escrituras, y sesión web y login automático) |
| `KV_REST_API_TOKEN` | **sí** | la crea la integración Upstash Redis del Marketplace |
| `CAMPUS_WRITE_TOKEN_VERSION` | no, opcional (por defecto `1`) | cambiarla revoca todos los tokens de escritura |
| `CAMPUS_WRITE_PROFILE` | no, opcional (por defecto `udesa-docente-escritura`) | perfil de escritura del remoto |

## Pasos manuales, en orden

En la carpeta del checkout (`udesa-mcp`), después de `npm ci && npm run build`. En los comandos, `campus` es `node build/cli.js`.

0. **CLI de Vercel:** `npm install -g vercel`. Los comandos `campus remote …` la usan para cargar variables.
1. **Login en Vercel** (vos): `vercel login`.
2. **Vincular el proyecto:** `vercel link` → crear un proyecto nuevo (por ejemplo, `udesa-mcp`) en tu cuenta Hobby.
3. **Primer deploy**, para conocer el dominio: `vercel deploy --prod`. Anotá el dominio de producción (p. ej. `https://<tu-proyecto>.vercel.app`). `/health` va a responder 503 con `{"ok":false,…}` (y la página `/` muestra «falta configuración»): es lo esperado. En *Settings → Deployment Protection*, verificá que el dominio de producción **no** pida login de Vercel (los clientes MCP no podrían entrar).
4. **OAuth App de GitHub** (vos, en <https://github.com/settings/developers> → *New OAuth App*):
   - Application name: por ejemplo, `UdeSA Campus MCP (privado)`
   - Homepage URL: `https://<dominio>`
   - Callback: en GitHub es la sección **Redirect URIs** (también puede figurar como *Authorization callback URL*) → `https://<dominio>/oauth/github/callback`. **Sin** *Allow wildcard matching*.
   - Sin *Device Flow*. *Expire user access tokens* puede quedar marcado (el servidor usa el token de GitHub una vez y lo descarta). Registrá la app, copiá el **Client ID** y generá un **Client secret**.
5. **Variables no secretas:** `campus remote configure --profile udesa-docente --base-url https://<dominio> --github-client-id <Client ID> --github-user-id <ID numérico de tu cuenta de GitHub>`
6. **Secreto de GitHub** (vos): `vercel env add GITHUB_CLIENT_SECRET production --sensitive` y pegás el secret cuando lo pida.
7. **Clave de firma:** `campus remote init-secret --profile udesa-docente`
8. **Token de Moodle:** `campus remote push-token --profile udesa-docente`. Requiere el login local vigente.
9. **Deploy con la configuración:** `vercel deploy --prod`. Verificá `https://<dominio>/health` → `{"ok":true,…}`.
10. **Conectar los clientes:** ver [CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md) (ChatGPT web, Codex, Claude Code, claude.ai, consulta de verificación y problemas conocidos).
11. **Escrituras remotas y sesión web compartida (opcional):** en el proyecto de Vercel, *Storage → Marketplace → Upstash Redis* y conectalo al proyecto: crea `KV_REST_API_URL` y `KV_REST_API_TOKEN`. Después, `vercel env add CAMPUS_WRITE_ENABLED production` → `true` y `vercel deploy --prod`. Sin esto, `/mcp-completo` y `/mcp-escritura` responden 404, y la sesión web compartida y el login web automático remoto (ADR-127) no están disponibles: el KV es donde guardan la sesión, el estado y el candado.

Los pasos 2, 3, 5, 7, 8 y 9 los puede correr el agente una vez hechos el 1, el 4 y el 6: ninguno muestra secretos.

La URL puede cargarse con o sin `/mcp`: el servidor atiende MCP en ambas rutas (`GET /` es la página informativa). ChatGPT, por ejemplo, usa la URL de la raíz.

## Mantenimiento

Procedimientos paso a paso (renovar credenciales, publicar, incidentes): [PROCESOS.md](PROCESOS.md).

- **Token de Moodle vencido:** las tools devuelven `AUTH_REQUIRED` con esta instrucción. Renovás el login local (`campus auth login --profile docente-lectura`), corrés `campus remote push-token --profile docente-lectura` y `vercel deploy --prod`.
- **Revocar todos los clientes conectados:** `campus remote init-secret --profile docente-lectura` + `vercel deploy --prod`. Cada cliente tendrá que volver a conectar. Para cortar sólo las escrituras: cambiar `CAMPUS_WRITE_TOKEN_VERSION` o quitar `CAMPUS_WRITE_ENABLED`, y redesplegar.
- **Cortar todo:** borrar `CAMPUS_MOODLE_TOKEN` en Vercel, borrar la OAuth App de GitHub o pausar el proyecto.
- **Sesión web:** vive en el KV, cifrada, y la comparten todas las instancias y los tres endpoints; las rotaciones del Campus se guardan (ADR-127). `CAMPUS_WEB_SESSION` es la semilla: publicar una nueva (`push-web-session` + deploy) gana sobre lo guardado. Sin sesión ni login automático, las herramientas que la necesitan devuelven `AUTH_REQUIRED` y el resto funciona igual.
- **Login web automático (ADR-127):** con `campus remote autologin enable` (en tu PC) y un deploy, el remoto inicia sesión solo cuando la sesión venció, con un dispositivo de confianza propio y sin pedir código. La confianza dura 28 días: `campus_get_status` avisa (`web_autologin.action_needed`) y se renueva repitiendo `enable` + deploy. Para cortarlo: `campus remote autologin disable` + deploy.
- **Deploy desde otra computadora:** instalá la CLI (`npm install -g vercel`), `vercel login` y vinculá el proyecto existente ([CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md#retomar-el-desarrollo-en-otra-computadora)). `vercel link` crea un `.env.local` con un token de Vercel: lo ignora git (`.env*`) y Vercel no lo sube.
- **Logs:** Vercel guarda los eventos mínimos del servidor (tool, resultado, duración). No contienen tokens ni contenido de avisos.

## Límites conocidos

- Sin almacenamiento, un código de autorización no se puede marcar como usado. Se mitiga con su vida de 120 s y con PKCE obligatorio.
- Los callbacks de ChatGPT no están en documentación oficial. En producción se observaron `https://chatgpt.com/connector_platform_oauth_redirect` y `https://chatgpt.com/connector/oauth/<id>`, ambos permitidos. Si aparece otro, el registro devuelve `invalid_redirect_uri` y hay que agregarlo en `src/remote/oauth.ts`.
- Lo que se lee (avisos, entregas, datos de participantes) pasa por Vercel y por el proveedor del cliente (Anthropic u OpenAI). Es tu cuenta, pero conviene recordarlo. Respetá las políticas de tu institución sobre datos de estudiantes.
- La sesión web se usa desde Vercel (otra IP que tu navegador). Si el Campus tuviera activado el control de IP de sesión, podría cerrarla.
- La sesión del remoto sale de la región de Vercel (`gru1`). En [Sesiones del navegador](https://campusvirtual.udesa.edu.ar/report/usersessions/user.php) se reconoce por la última IP, de Amazon (región de São Paulo): esa página no muestra el navegador. El User-Agent `udesa-campus-mcp/0.1 (MCP del Campus; remoto)` aparece en el correo del código.
- **Enlaces de descarga (ADR-113):** `campus_get_original_file` con `delivery: link` emite `/descarga/<token>`, firmado con una clave derivada de `OAUTH_SIGNING_SECRET`; rotarla invalida los enlaces vigentes. Quien tenga el enlace baja el archivo durante 15 minutos. No se emiten para entregas, devoluciones ni adjuntos de foros.
- No es multiusuario: cada persona despliega el suyo. Un servicio compartido requeriría custodia de tokens ajenos, base de datos cifrada y visto bueno institucional.

## Laboratorio (opcional)

`lab/` es un proyecto de Vercel **aparte**: mini-aplicaciones (por ahora, ejercicios de Python con pruebas automáticas) para incrustar en actividades H5P o enlazar como herramienta LTI (ADR-116 y ADR-117). Se despliega desde esa carpeta con su propio `vercel link` y `vercel deploy --prod`.

Por defecto, el MCP apunta a la instancia pública del autor (`https://udesa-campus-lab.vercel.app`): los ejercicios de Python que genera la incrustan. Para usar la tuya, desplegá `lab/` y configurá las variables.

**En el MCP (servidor local o remoto):**

| Variable | Para qué |
|---|---|
| `CAMPUS_LAB_BASE_URL` | URL de tu laboratorio (por defecto, la instancia del autor) |
| `CAMPUS_LAB_LTI11_KEY` | Clave de consumidor LTI 1.1 con la que se registra la herramienta en el Campus (por defecto `udesa-lab`) |
| `CAMPUS_LAB_LTI11_SECRET` | Secreto LTI 1.1 compartido con el laboratorio (sensible) |

**En el proyecto del laboratorio:**

| Variable | Para qué |
|---|---|
| `LAB_BASE_URL` | Su propia URL pública |
| `LTI11_KEY`, `LTI11_SECRET` | Clave y secreto LTI 1.1 (los mismos que en el MCP) |
| `LTI_STATE_SECRET` | Clave para firmar el estado y la sesión de calificación (base64url, sensible) |
| `LTI_PRIVATE_KEY` | Clave privada RSA de la herramienta LTI 1.3 (PEM, sensible) |
| `LTI_REGISTRATIONS` | Registros LTI 1.3 de la herramienta en el Campus, uno por curso: `clientId:deploymentId,clientId:deploymentId` |
| `LTI_PLATFORM_ISS`, `LTI_AUTH_URL`, `LTI_TOKEN_URL`, `LTI_JWKS_URL` | Datos del Campus; por defecto, los de UdeSA |

**Las notas del laboratorio las informa el navegador del estudiante:** sirven para práctica calificada, no para exámenes.

Las páginas del servidor (la de inicio y la del laboratorio) enlazan al repositorio original y al Cafecito del autor: se cambian en `REPO_URL` y `CAFECITO_URL` de `src/remote/handler.ts` y en el pie de `lab/index.html`.


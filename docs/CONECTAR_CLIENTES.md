# Conectar clientes y retomar en otra computadora

Guía para usar el MCP del Campus desde cualquier máquina con tu servidor remoto ya desplegado ([REMOTO_VERCEL.md](REMOTO_VERCEL.md)). Conectar un cliente nuevo **no requiere** clonar este repo, instalar Node ni loguearse en Moodle en esa máquina.

En los ejemplos, `https://<tu-proyecto>.vercel.app` es el dominio de producción de tu proyecto de Vercel.

## Qué ofrece el remoto

| Dato | Valor |
|---|---|
| URLs del MCP | `/mcp` (sólo lectura; también responde en la raíz), `/mcp-completo` (lecturas y escrituras) y `/mcp-escritura` (sólo escrituras), en `https://<tu-proyecto>.vercel.app` |
| Acceso | Sólo la cuenta de GitHub configurada en `GITHUB_ALLOWED_USER_ID`, vía tu OAuth App de GitHub |
| Alcance de `/mcp` | Sólo lectura. Perfil `docente-lectura` (`udesa-docente`): todos los cursos donde la cuenta está matriculada en Moodle, con cualquier rol, resueltos en vivo (ADR-122). Con cualquier rol: contenido, foros, avisos, calendario, vencimientos, tus notas, tus intentos y tus mensajes privados. Donde la cuenta es docente o superior, además: entregas, notas, intentos de cuestionarios, participantes (con email, legajo, país, descripción y foto), grupos, asistencia y pendientes por corregir. Con sesión web, también estructura de cuestionarios, preguntas y reportes. Catálogo en [HERRAMIENTAS.md](HERRAMIENTAS.md) |
| Nombre de servidor recomendado | `udesa-campus` |

| Cliente | Estado |
|---|---|
| ChatGPT web | Funciona |
| Codex (CLI, extensión de VS Code y app) | Funciona |
| Claude Code (terminal y extensión de VS Code) | Funciona |
| claude.ai | Sin probar: en un plan Team sólo un Owner agrega conectores (ver [abajo](#claudeai)) |
| MCP local por STDIO (sin Vercel) | Funciona: [CONFIGURACION_LOCAL.md](CONFIGURACION_LOCAL.md) |

Cada computadora tiene su propio keyring: el login, la sesión web y, si se activa, la contraseña del login automático se cargan **en cada una**. El remoto (Vercel) es independiente de todas: tiene su propia sesión web y, con el [login web automático remoto](PROCESOS.md#login-web-automático-en-el-remoto) (ADR-127), su propio dispositivo de confianza, que se renueva cada 28 días desde una computadora con el repo, con `remote autologin enable` y un deploy.

## Cómo es cada conexión

Todos los clientes remotos siguen el mismo flujo la primera vez:

1. El cliente descubre que el servidor pide OAuth y se registra solo.
2. Se abre el navegador en **«Autorizar acceso al Campus»**. Verificá que el cliente nombrado sea el que acabás de conectar y tocá **Continuar con GitHub**.
3. GitHub confirma tu cuenta. La primera vez muestra su propia pantalla de autorización; después pasa directo.
4. El navegador vuelve al cliente y queda conectado. El acceso dura 1 hora y el cliente lo renueva solo. Si pasa 30 días sin usarlo, hay que volver a autorizar.

Nunca se pide la contraseña del Campus ni un token: el token de Moodle vive sólo en Vercel.

## ChatGPT web

Se configura una vez por cuenta de ChatGPT y queda disponible en cualquier computadora o navegador con esa cuenta.

1. *Settings → Apps & Connectors → Advanced* → activar **Developer mode**. La ubicación cambia según la versión; el modo depende del plan.
2. *Create* (nuevo conector):
   - Name: `UdeSA Campus`
   - MCP Server URL: `https://<tu-proyecto>.vercel.app/mcp`
   - Authentication: **OAuth**
3. Completar el flujo de arriba una sola vez. No hace falta volver atrás ni reenviar el formulario.
4. En un chat nuevo, habilitar el conector y hacer la consulta de verificación.

Si dice que no hay acciones disponibles o «discovery failed», **borrá el conector y crealo de nuevo**: ChatGPT guarda la lista de herramientas del primer intento.

## Codex

La configuración vive en `~/.codex/config.toml` y la comparten la CLI, la extensión de VS Code y la app de Codex. Va una vez por computadora.

**Si tenés la CLI** (`codex --version` funciona):

```bash
codex mcp add udesa-campus --url https://<tu-proyecto>.vercel.app/mcp
```

El comando abre el OAuth automáticamente. Si no lo abre, o para renovarlo:

```bash
codex mcp login udesa-campus
```

**Si sólo tenés la extensión de VS Code (Windows)**, usá el `codex.exe` que trae incluido, en PowerShell:

```powershell
$codex = (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\openai.chatgpt-*\bin\windows-x86_64\codex.exe" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; & $codex mcp add udesa-campus --url https://<tu-proyecto>.vercel.app/mcp
```

En macOS/Linux la ruta es análoga (`~/.vscode/extensions/openai.chatgpt-*/bin/<plataforma>/codex`). También se puede instalar la CLI con `npm install -g @openai/codex`.

**Alternativa manual:** agregar al final de `~/.codex/config.toml`:

```toml
[mcp_servers.udesa-campus]
url = "https://<tu-proyecto>.vercel.app/mcp"
```

y después correr `codex mcp login udesa-campus`.

Para verificar: `codex mcp list` debe mostrar `udesa-campus … enabled  OAuth`.

## Claude Code

Funciona igual en la terminal y en la extensión de VS Code. Va una vez por computadora.

```bash
claude mcp add --transport http --scope user udesa-campus https://<tu-proyecto>.vercel.app/mcp
```

Después, en una sesión de Claude Code: `/mcp` → `udesa-campus` → **Authenticate**, y seguir el flujo en el navegador.

- **Usá `--scope user`.** Con `--scope local` la configuración queda atada a la ruta exacta del proyecto. En Windows, la CLI escribe `C:/…` y la extensión de VS Code `c:/…`, y Claude Code las trata como proyectos distintos: el servidor «desaparece» en VS Code. Con `user` no pasa.
- **Si en esa computadora ya tenés el MCP local** como `udesa-campus` (lee con el token del keyring, sin pasar por Vercel), no agregues el remoto con el mismo nombre: se duplicarían las herramientas. Para probar el remoto ahí, usá otro nombre (por ejemplo, `udesa-campus-remoto`).

Para verificar: `claude mcp get udesa-campus` debe decir `✔ Connected`, o `Needs authentication` antes del paso de `/mcp`.

## Perfil docente-completo: un conector para leer y escribir (ADR-062)

`https://<tu-proyecto>.vercel.app/mcp-completo` (alcance `campus.write`) tiene todas las tools de lectura y las de escritura juntas. Es el que conviene para un cliente que escribe. Admite todos los riesgos, también los borrados R4 (ADR-118); R3 y R4 se ejecutan sólo con la aprobación del usuario. Los adjuntos de foros y la importación de preguntas sólo funcionan en el servidor local (`serve-full`), porque usan archivos locales. Desde ChatGPT sí se pueden subir archivos a recursos y carpetas: ChatGPT los entrega en `files` / `add_files` (ADR-129). Escribe en todos los cursos donde tu rol es de profesor, gestor o superior (ADR-125). Qué permite por tipo de elemento: [SANDBOX_ELEMENTOS.md](SANDBOX_ELEMENTOS.md). El conector `/mcp` es `docente-lectura`, sólo lectura. No conectes los dos en el mismo cliente, porque las lecturas se duplicarían.

```bash
claude mcp add --transport http --scope user udesa-campus-completo https://<tu-proyecto>.vercel.app/mcp-completo
```

**Por cliente:**
- **ChatGPT web:** conector «UdeSA Campus completo» (Developer mode). Antes de ejecutar una escritura, ChatGPT puede pedir confirmación en el chat; es su comportamiento propio.
- **Codex:** `codex mcp add udesa-campus-completo --url https://<tu-proyecto>.vercel.app/mcp-completo`. Pide aprobación para `campus_execute_plan` porque está marcado como destructivo; en `codex exec` desatendido no se puede aprobar y la llamada se rechaza. La referencia oficial de configuración de Codex admite una aprobación por herramienta de MCP (`approval_mode`: `auto`, `prompt`, `writes` o `approve`; la referencia no describe cada valor). Para no tener que aprobarla, en `~/.codex/config.toml`:

  ```toml
  [mcp_servers.udesa-campus-completo.tools.campus_execute_plan]
  approval_mode = "approve"
  ```

  No está probado con este servidor. Ejecutar sin aprobación en el cliente es lo que define ADR-061: el plan ya es la revisión.
- **Claude Code:** se ejecuta sin preguntar si el tool está permitido (`--allowedTools` o los permisos del proyecto).

Cada conector tiene su propio token: el de `/mcp-escritura` no abre `/mcp-completo`, ni al revés. La revocación ([abajo](#escrituras-remotas)) vale para los dos.

## Escrituras remotas

Opcional: para escribir conviene `/mcp-completo` (arriba). `/mcp-escritura` es un conector sólo de escrituras, con otra URL y otro permiso: `https://<tu-proyecto>.vercel.app/mcp-escritura` (alcance `campus.write`). El de lectura no lo abre, y el token de escritura no abre la lectura.

- **Qué permite:** las herramientas `campus_plan_*` y `campus_execute_plan` del servidor de escritura, en los cursos habilitados en `profiles/udesa-docente-escritura.json`: todos los cursos donde tu rol es de profesor, gestor o superior (ADR-125). R3 y R4 piden tu aprobación en el chat. Adjuntos e importación de preguntas quedan en el servidor local, porque necesitan archivos de tu PC.
- **Cómo se aprueba:** el perfil está en `require_out_of_band_from_risk: "nunca"` y no se pide aprobación fuera del chat (ADR-061). Los planes R3 y R4 sí necesitan al usuario (ADR-118): el agente se los plantea y ejecuta con sus palabras en `user_approval`. Con un umbral (`R1` o `R2`), el plan pide aprobación **fuera del chat**, en la página `https://<tu-proyecto>.vercel.app/aprobar/<plan_id>`, que da el propio plan.
  1. La página pide GitHub (sólo la cuenta permitida) y muestra el plan completo con su código.
  2. Aprobás o rechazás.
  3. Le pedís al agente que lo ejecute.
- **Conectar en Claude Code:** `claude mcp add --transport http --scope user udesa-campus-escritura-remoto https://<tu-proyecto>.vercel.app/mcp-escritura`, y después `/mcp` → **Authenticate**. La pantalla de autorización dice **ESCRITURA**.
- **Revocar sólo la escritura:** cambiar `CAMPUS_WRITE_TOKEN_VERSION` en Vercel (por ejemplo, a `2`) y redesplegar. Todos los tokens de escritura dejan de servir y la lectura sigue igual. Para apagarla del todo: quitar `CAMPUS_WRITE_ENABLED` y redesplegar.

## claude.ai

En un plan Team/Enterprise sólo un **Owner** puede agregar conectores personalizados: *Settings → Connectors → Add custom connector* con la misma URL. Que lo agregue no le da acceso a nadie más, porque cada persona se autentica y el servidor sólo acepta la cuenta de GitHub configurada. Con una cuenta personal (Pro/Max) lo agregás vos mismo. Después aparece también en el celular.

## Consulta de verificación

En cualquier cliente:

> ¿Qué avisos recientes hay en el Campus para el curso 12345? Citá título, fecha y enlace, el momento de consulta y si la cobertura fue completa.

(Usá el ID de uno de tus cursos; `campus_list_courses` los muestra.) Una respuesta correcta trae enlaces a `campusvirtual.udesa.edu.ar/mod/forum/discuss.php?d=…`, la fecha y hora de la consulta, y aclara si la lista es parcial. Si el cliente responde que «no hay avisos» sin mencionar un error, desconfiá: el servidor nunca devuelve una lista vacía ante un error.

## Archivos originales por cliente (ADR-113)

`campus_get_original_file` deja que el modelo elija dónde queda el archivo (`delivery`):

| Cliente | Qué conviene |
|---|---|
| Claude Code (local o remoto) | `inline`: Claude Code guarda el archivo incrustado en la carpeta de resultados de la sesión (`~/.claude/projects/…/tool-results/`) y le pasa la ruta al modelo. `computer` (local) si el usuario lo quiere en Descargas |
| Codex | `computer` (servidor local): su sandbox puede leer la carpeta de Descargas. `inline` no: según un issue de Codex, pega el contenido en el contexto |
| ChatGPT | `link`: el usuario baja el archivo y se lo sube al chat, o un agente con red (modo agente) lo baja a su sandbox. `inline` hasta 2,5 MB, pero OpenAI no documenta que el archivo llegue al sandbox de Python |

El enlace dura 15 minutos y cualquiera que lo tenga puede bajar el archivo: no se emite para entregas, devoluciones ni adjuntos de foros.

## Problemas conocidos

| Síntoma | Causa | Qué hacer |
|---|---|---|
| Claude Code en VS Code no ve el servidor | Configuración con `--scope local` bajo `C:/` vs `c:/` | Usar `--scope user` (o duplicar la entrada en ambas claves de `~/.claude.json`) |
| ChatGPT: «discovery failed» o sin acciones | Lista de herramientas guardada de un intento fallido | Borrar y recrear el conector |
| Las tools devuelven `AUTH_REQUIRED` con «push-token» | Venció o se revocó el token de Moodle del servidor | Renovarlo: [PROCESOS.md](PROCESOS.md#renovar-el-token-móvil) |
| Sólo estructura, preguntas o reportes devuelven `AUTH_REQUIRED` («sesión web») | Venció la sesión web y el login automático no pudo entrar (o no está activo) | Lo que diga el mensaje. En el remoto, `campus_get_status` → `web_autologin.action_needed`; si hay que renovar la confianza: [login web automático en el remoto](PROCESOS.md#login-web-automático-en-el-remoto). Sin login automático: [renovar la sesión web](PROCESOS.md#renovar-la-sesión-web) |
| No aparece una herramienta nueva | El cliente guardó la lista vieja | ChatGPT: actualizar o recrear el conector. Codex y Claude Code: sesión nueva |
| El cliente pide autorizar otra vez | El cliente pasó 30 días sin renovar el acceso, se rotó `OAUTH_SIGNING_SECRET` o, en `/mcp-completo` y `/mcp-escritura`, cambió `CAMPUS_WRITE_TOKEN_VERSION` | Repetir el flujo |
| `invalid_redirect_uri` al conectar un cliente nuevo | El cliente usa un callback que no está en la allowlist | Agregarlo en `isAllowedRedirect` (`src/remote/oauth.ts`), test y deploy |

## Retomar el desarrollo en otra computadora

Hace falta sólo para cambiar código, redesplegar o renovar credenciales del remoto. Para usar el MCP alcanzan las secciones anteriores.

```bash
git clone https://github.com/changazo/udesa-mcp.git
```

```bash
cd udesa-mcp && npm ci && npm run build && npm test
```

Vincular con tu proyecto existente de Vercel. **No crees uno nuevo:** las variables y el dominio viven en ese. Si la CLI no está instalada:

```bash
npm install -g vercel
```

```bash
vercel login
```

El login de Vercel abre el navegador con un código de dispositivo. Al empezar puede mostrar un error de «Worker timed out»: es el chequeo de versión de la CLI y no afecta el login.

```bash
vercel link --yes --project <tu-proyecto> --scope <tu-equipo-de-vercel>
```

- **`vercel link` crea `.env.local`** con un token OIDC de Vercel. Lo ignora git (`.env*` en `.gitignore`) y Vercel no lo sube al desplegar. No lo compartas.
- **Ningún secreto está en el repo.** Las variables de entorno (lista completa en [REMOTO_VERCEL.md](REMOTO_VERCEL.md#variables-de-entorno-production)) viven en Vercel (`vercel env ls production`), y la OAuth App de GitHub no cambia entre máquinas.
- **Deploy:** `vercel deploy --prod` (agregá `--yes` para no responder preguntas). Si el repo no está conectado a Vercel por Git, un push no despliega solo. Después: `https://<tu-proyecto>.vercel.app/health` tiene que responder `ok:true`.
- **Logs** (rutas y eventos, sin tokens ni contenido): `vercel logs --environment production --since 30m`.
- **Renovar el token de Moodle** desde esa máquina: [PROCESOS.md](PROCESOS.md#renovar-el-token-móvil). El login guarda el token en el keyring de *esa* computadora (con contraseña o con Google, ver [LOGIN_GOOGLE.md](LOGIN_GOOGLE.md)).

- **MCP local por STDIO en esa máquina** (opcional, sin Vercel):
  1. Hacé el login local como arriba.
  2. Configurá el cliente según [CONFIGURACION_LOCAL.md](CONFIGURACION_LOCAL.md#4-claude-code), con las dos entradas, la ruta absoluta de Node y los comandos en Git Bash.
  3. Para la sesión web, importala y mantenela viva con el keepalive o, si el keepalive no es viable en esa computadora, activá el [login web automático](PROCESOS.md#login-web-automático-opcional-no-recomendado).

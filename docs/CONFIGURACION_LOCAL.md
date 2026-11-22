# Configuración local

Todo corre en tu máquina. No hay servidor público, túnel ni puerto abierto.

## 1. Instalar y compilar

En la carpeta del checkout (cada computadora tiene la suya):

```bash
npm ci
npm run build
npm test
```

En los ejemplos de abajo, `<ruta>` es la carpeta del checkout con barras `/` (por ejemplo `C:/Users/<usuario>/Documents/udesa-mcp`).

## 2. Login (lo hacés vos, en tu terminal)

```bash
node build/cli.js auth login --profile udesa-docente --method native
```

- Pide usuario (visible) y contraseña (sin eco). No acepta credenciales por argumentos, pipe ni variables de entorno.
- Envía un único POST a `https://campusvirtual.udesa.edu.ar/login/token.php` con `service=moodle_mobile_app`. Sin reintentos.
- Valida el token con `core_webservice_get_site_info` (sitio y `userid`) y recién ahí lo guarda en el **Administrador de credenciales de Windows** (entrada `udesa-campus-mcp`). La contraseña no se guarda, salvo que actives el login web automático (opcional y no recomendado: ADR-088).
- Si el almacén seguro no responde, aborta **antes** de pedir la contraseña: no hay fallback a texto plano.

Nunca pegues contraseñas, tokens ni URLs de retorno en el chat con el agente.

Resultados posibles y qué significan:

| Código | Significado | No significa |
|---|---|---|
| `AUTH_REJECTED` + `invalidlogin` | token.php no aceptó usuario/contraseña | que el login web falle, ni que no haya API |
| `SERVICE_UNAVAILABLE` + `enablewsdescription`/`servicenotavailable` | el sitio no emite tokens para ese servicio | que se pueda «forzar»: no hay bypass |
| `UNEXPECTED_RESPONSE` | respondió HTML u otra cosa | contraseña incorrecta |
| `NETWORK_ERROR` | red, DNS, TLS o timeout | nada sobre Moodle |

### Alternativa: login con Google institucional

```bash
node build/cli.js auth login --profile udesa-docente --method browser
```

Abre tu navegador, hacés el login con Google y, en la página «Confirmado» del Campus, copiás con clic derecho el enlace «Haga clic aquí…» y lo pegás en la terminal. Validado con Google real. Paso a paso y qué hacer ante cada problema: [LOGIN_GOOGLE.md](LOGIN_GOOGLE.md).

## 3. Diagnóstico

```bash
node build/cli.js diagnose --profile udesa-docente
```

Sólo lecturas. Muestra identidad, cantidad de funciones del servicio, los cursos del alcance del perfil y, para cada uno, estructura, foros, cómo se identificó Avisos y los títulos de los tres avisos más recientes para que los compares con lo que ves en el Campus. Guarda un reporte de capacidades saneado en `%LOCALAPPDATA%\udesa-campus-mcp\profiles\<perfil>\capability-report.json` (en macOS y Linux, `~/.local/state/udesa-campus-mcp/profiles/<perfil>/`, o bajo `$XDG_STATE_HOME`).

`--appsitecheck` agrega una consulta **no autenticada** a `login/token.php?appsitecheck=1`; es sólo una pista sobre Web Services.

## 4. Claude Code

Dos entradas posibles, con las mismas credenciales del keyring:

| Entrada | Servidor | Tools | Variables |
|---|---|---|---|
| `udesa-campus` | `serve --profile udesa-docente` (= `docente-lectura`) | Lecturas | `CAMPUS_READ_ONLY=true` |
| `udesa-campus-completo` | `serve-full --profile docente-completo` | Lecturas + escrituras (en los cursos donde tu rol es de profesor, gestor o superior) | `CAMPUS_WRITE_ENABLED=true` |

Los perfiles sirven con cualquier rol: un estudiante lee lo suyo en todos sus cursos, y quien es docente o gestor en un curso además ve los datos de otras personas y puede escribir ahí. Si no vas a escribir, alcanza con `udesa-campus`.

Con las dos conectadas, las tools de lectura aparecen duplicadas. Para un cliente que escribe alcanza con `udesa-campus-completo` ([PROCESOS.md](PROCESOS.md#perfiles-docente-lectura-y-docente-completo-adr-062)). En las dos, `CAMPUS_WEB_AUTOLOGIN=true` es la segunda llave del [login web automático](PROCESOS.md#login-web-automático-en-la-pc-recomendado) (opcional).

**Con `--scope user`** (recomendado: no depende de la ruta del proyecto). Usá la ruta **absoluta** de `node.exe`: la app de escritorio de Claude puede no tener el `PATH` de tu terminal. Con el instalador oficial es `C:/Program Files/nodejs/node.exe`; con scoop, `C:/Users/<usuario>/scoop/apps/nodejs/current/node.exe` (`current` sigue las actualizaciones).

```bash
claude mcp add udesa-campus --scope user -e CAMPUS_READ_ONLY=true -- <node.exe> <ruta>/build/cli.js serve --profile udesa-docente
```

```bash
claude mcp add udesa-campus-completo --scope user -e CAMPUS_WRITE_ENABLED=true -- <node.exe> <ruta>/build/cli.js serve-full --profile docente-completo
```

- **Corré estos comandos en Git Bash o en `cmd`, no en PowerShell.** El script `claude.ps1` se come el `--`, y `claude` termina interpretando `--profile` como opción propia («unknown option '--profile'»).
- Para cambiar una variable: `claude mcp remove <nombre> -s user` y volver a agregarla con todas las `-e`.
- Verificá con `claude mcp get <nombre>`: tiene que decir `✔ Connected`. Las tools nuevas aparecen en una sesión nueva de Claude.

**Por proyecto**, con un `.mcp.json` en la raíz del proyecto donde trabaja el agente:

```json
{
  "mcpServers": {
    "udesa-campus": {
      "type": "stdio",
      "command": "node",
      "args": ["<ruta>/build/cli.js", "serve", "--profile", "udesa-docente"],
      "env": { "CAMPUS_READ_ONLY": "true" }
    }
  }
}
```

**Ojo en Windows con el alcance `local`:** la entrada se guarda en `~/.claude.json` bajo la ruta del proyecto *tal como la escribe cada cliente*. La CLI escribe `C:/Users/…/proyecto` y la extensión de VS Code `c:/Users/…/proyecto` (unidad en minúscula). Son claves distintas: si la entrada está sólo en una, el servidor no aparece en VS Code. Duplicala en ambas claves y, si cambiás la configuración, hacelo en las dos (o usá `--scope user` o un `.mcp.json` de proyecto, que no dependen de la ruta).

Las variables `CAMPUS_*` sólo pueden **confirmar** el perfil; si contradicen el perfil, el servidor no arranca (no hay fallback silencioso). El token no va en esta configuración.

## 5. Codex

En `~/.codex/config.toml` o la configuración de proyecto que soporte tu versión (verificá la sintaxis en la versión instalada):

```toml
[mcp_servers.udesa-campus]
command = "node"
args = ["<ruta>/build/cli.js", "serve", "--profile", "udesa-docente"]

[mcp_servers.udesa-campus.env]
CAMPUS_READ_ONLY = "true"
```

Con `serve` (perfil `docente-lectura`) todas las herramientas son de lectura, así que no hace falta `enabled_tools`. Para leer y escribir en un solo servidor, usá `serve-full --profile docente-completo` con `CAMPUS_WRITE_ENABLED=true` ([PROCESOS.md](PROCESOS.md#escrituras)). Si querés acotarlas, usá los nombres de [HERRAMIENTAS.md](HERRAMIENTAS.md). Una lista fija queda vieja cuando se agregan herramientas.

`codex mcp login` no reemplaza el login de Moodle: éste se hace con la CLI del paso 2.

## Sesión web (para lo que no está en el servicio móvil)

Algunas lecturas (estructura de cuestionarios, preguntas, reportes, historial de asistencia, preguntas de encuestas) y varias escrituras de `docente-completo` que van por formularios del Campus (crear tareas, H5P, LTI del laboratorio, entre otras; ver [HERRAMIENTAS.md](HERRAMIENTAS.md)) usan la web del Campus y no el token móvil. Para eso hace falta una **sesión web**. El resto de las herramientas no la necesita.

**Método recomendado: login web automático** (ADR-142). El MCP local inicia sesión en la web solo, con la contraseña guardada en el Administrador de credenciales, y sólo pide el código del correo una vez por mes:

```bash
node build/cli.js auth web autologin enable --profile udesa-docente
```

Después agregá `CAMPUS_WEB_AUTOLOGIN=true` a la entrada del cliente MCP (segunda llave) y abrí una sesión nueva. La confianza del dispositivo se renueva con el panel de esta PC (`auth web panel`). Paso a paso: [PROCESOS.md](PROCESOS.md#login-web-automático-en-la-pc-recomendado).

**Respaldo: importar la cookie `MoodleSession`** de tu navegador, para quien no quiere guardar la contraseña.

1. Abrí el Campus en tu navegador con tu cuenta (o usá `--open`). Si querés que la sesión no dependa de tu navegación diaria, usá una ventana o un perfil aparte y no cierres sesión ahí.
2. Herramientas de desarrollador (F12) → **Application** (Aplicación) → **Cookies** → `https://campusvirtual.udesa.edu.ar` → copiá el **Value** de `MoodleSession`.
3. Importala desde tu terminal. Con `--clipboard` la toma del portapapeles y lo vacía después; sin `--clipboard`, la entrada no se muestra y también se puede pasar por stdin:

```bash
node build/cli.js auth web import --profile udesa-docente --clipboard
```

La CLI valida la cookie antes de guardarla: comprueba que el Campus la acepte y que autentique a tu misma cuenta (el userid del login). Sólo guarda cookies de sesión de Moodle (`MoodleSession*`, `MOODLEID*`), cifradas en el registro de la conexión de esta PC (la clave está en el Administrador de credenciales).

- Estado: `node build/cli.js auth web status --profile udesa-docente --verify` (incluye el último uso y el vencimiento estimado por inactividad).
- Borrar la copia local: `node build/cli.js auth web logout --profile udesa-docente --local` (no cierra la sesión del navegador).
- **Duración:** la de esa sesión en el Campus. Vence tras 4 horas sin uso (medido en UdeSA) o si cerrás sesión en ese navegador. Cuando vence, las lecturas web devuelven `AUTH_REQUIRED` con el comando para esta PC ([PROCESOS.md](PROCESOS.md#renovar-la-sesión-web)). Si el Campus rota la cookie durante el uso, el MCP guarda la versión rotada ya validada.
- **Vaciar el portapapeles no borra el historial de Windows (Win+V)** ni su sincronización: si los usás, borrá esa entrada a mano.
- Para no reimportarla sin activar el login automático: el keepalive ([PROCESOS.md](PROCESOS.md#mantener-viva-la-sesión-web)).
- La cookie da acceso a tu cuenta como el navegador: no la pegues en chats, issues ni capturas.

## Descargas y páginas como imágenes

- `campus_get_original_file` con `delivery: computer` (por defecto en el servidor local) guarda el archivo original en `~/Downloads/udesa-campus-mcp/<curso>/`. Para otra carpeta: `CAMPUS_DOWNLOAD_DIR` (ADR-112 y 113).
- `campus_get_file_images` con `render: true` dibuja diapositivas y páginas completas. Necesita LibreOffice (para Office) y `pdftoppm` (Poppler) o Ghostscript. Se buscan en el `PATH` y en las rutas habituales; si están en otro lado: `CAMPUS_SOFFICE`, `CAMPUS_PDFTOPPM`, `CAMPUS_GHOSTSCRIPT`.

## Entornos

- **Windows nativo:** el sistema validado con el Campus real (keyring: Administrador de credenciales de Windows).
- **macOS y Linux:** sin validar. El keyring es el del sistema (Llavero en macOS, Secret Service en Linux) a través de `@napi-rs/keyring`; sin él, el login falla con `SECRET_STORE_UNAVAILABLE` (a propósito). No hay diálogos de Windows: el código del correo y las aprobaciones fuera del chat van por la terminal. El keepalive se programa con `cron` o `launchd` en lugar de la tarea de Windows. El estado queda en `~/.local/state/udesa-campus-mcp` (o bajo `$XDG_STATE_HOME`).
- **WSL:** el keyring de Windows no se comparte con WSL; vale lo dicho para Linux.
- **Agentes cloud:** no comparten tu keyring ni tu navegador. No copies sesiones ni tokens a un contenedor.

## Cerrar sesión local

```bash
node build/cli.js auth logout --profile udesa-docente --local
```

Borra el token del keyring y la metadata local. **No** revoca el token en Moodle: el mismo token podría estar usándolo la app oficial, porque `token.php` reutiliza tokens existentes.

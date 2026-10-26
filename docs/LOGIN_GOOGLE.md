# Iniciar sesión con Google institucional (guía práctica)

Cómo obtener la sesión del MCP con el botón «Continuar con cuenta institucional UdeSA», sin usar la contraseña del Campus. Detalles técnicos y de seguridad: [AUTH_BROWSER.md](AUTH_BROWSER.md).

## Cuándo usarlo

- Para iniciar o **renovar** la sesión local del MCP (por ejemplo, cuando las herramientas devuelven `AUTH_REQUIRED`) sin escribir la contraseña del Campus.
- En otra computadora donde quieras el modo local (STDIO).
- Da el mismo resultado que el login con contraseña: la misma cuenta de Moodle (el mismo userid) y, como Moodle reutiliza el token vigente, el mismo token.

Para conectar ChatGPT, Codex o Claude Code al **servidor remoto** no hace falta: eso usa el login con GitHub ([CONECTAR_CLIENTES.md](CONECTAR_CLIENTES.md)).

## Retorno automático (Windows, en pausa)

> **En pausa.** Funciona en un Chrome limpio, pero en algunos perfiles de Chrome el navegador no ofrece abrir el esquema. El método vigente es el pegado manual del [paso a paso](#paso-a-paso).

Con el esquema `udesacampusmcp` registrado en tu usuario de Windows, no hace falta copiar y pegar: al final del login el navegador entrega el enlace solo a la terminal.

**Instalación (una vez por computadora y usuario; no requiere administrador):**

```bash
node build/cli.js auth handler install
```

- Registra `HKCU\Software\Classes\udesacampusmcp`: sólo tu usuario, sin permisos de administrador. Al abrirse `udesacampusmcp://…`, Windows ejecuta `node …\build\cli.js auth callback "<enlace>"`. Ese proceso entrega el enlace por un canal local (named pipe de tu usuario) al login que está esperando y se cierra. No lo guarda ni lo muestra.
- Ver el estado: `node build/cli.js auth handler status`. Quitarlo: `node build/cli.js auth handler uninstall`.
- Si movés la carpeta del proyecto o cambia la instalación de Node, la ruta registrada queda vieja: el login lo avisa. Reinstalá con `auth handler install`.
- Nunca se registra `moodlemobile` (el esquema de la app oficial).

**Uso:** el mismo comando del paso a paso; la terminal muestra «RETORNO AUTOMÁTICO ACTIVO». En la página «Registro confirmado», hacé **clic izquierdo en el enlace azul** «Haga clic aquí si la aplicación no se abre automáticamente». El navegador pregunta si abrir una aplicación externa (puede figurar como Node.js, `node.exe` o el comando registrado, no como «UdeSA Campus MCP»): tocá «Abrir» (podés marcar «Permitir siempre»). Aparece un instante una ventana que dice «retorno entregado a la terminal», y la terminal termina sola con «retorno automático». Chrome **no** abre el esquema por su cuenta: la página intenta un clic automático, pero Chrome exige un clic real del usuario. Si no pregunta o no avanza, el pegado manual sigue disponible en la misma terminal.

## Requisitos

- El proyecto compilado (`npm ci && npm run build`) en esa computadora.
- Una **terminal interactiva** (no funciona por pipe ni desde un agente).
- Tu navegador habitual. No hace falta incógnito ni cerrar la sesión del Campus.

## Paso a paso

**1. Corré el comando en tu terminal**, dentro de la carpeta de tu copia del repositorio:

```bash
node build/cli.js auth login --profile udesa-docente --method browser
```

La terminal muestra instrucciones y un «Enlace de inicio» (no tiene secretos), abre tu navegador y queda esperando en `Retorno (no se muestra):`. Tenés **10 minutos**.

**2. En el navegador, completá el login con Google** como siempre: elegí tu cuenta `@udesa.edu.ar` y lo que te pida (MFA incluido). **No uses F5 ni vuelvas atrás.**

**3. Al final vas a ver una página del Campus que dice «Registro confirmado»**, con un botón «Cursos» y un enlace azul: «Haga clic aquí si la aplicación no se abre automáticamente».

- Hacé **clic derecho sobre el enlace azul → «Copiar dirección del enlace»**.
- **No copies la barra de direcciones.** La URL de la página (`…/launch.php?service=…&passport=…&confirmed=1`) no sirve: lo que se pega es el destino del enlace, que empieza con `udesacampusmcp://token=…`.
- Si Windows ofrece abrir la app de Moodle, cancelá. El enlace sigue en la página.

**4. Volvé a la terminal, pegá (no se ve nada) y apretá Enter.** El enlace contiene tu token: no lo pegues en chats, issues, documentos ni capturas, **ni en la barra de direcciones del navegador**. Si el navegador no reconoce el esquema, lo manda como búsqueda a Google y el token queda en el historial de búsqueda: en ese caso, ver [Si el token se expuso](#si-el-token-se-expuso).

**5. Resultado esperado:**

```text
Sesión validada por navegador: userid <tu userid> en https://campusvirtual.udesa.edu.ar (método browser, proveedor 4, retorno pegado).
Para que el retorno vuelva solo la próxima vez: campus auth handler install     ← sólo si el retorno automático no está instalado
```

Con el [retorno automático](#retorno-automático-windows-en-pausa), antes aparece «Retorno recibido automáticamente desde el navegador.» y la línea termina en «retorno automático».

Para verificarlo después: `node build/cli.js auth status --profile udesa-docente --verify` → `"authenticated": true`, `"auth_method": "browser"`.

## Si algo no sale así

| Lo que ves | Qué pasó | Qué hacer |
|---|---|---|
| «Actualmente ha iniciado sesión como …, necesita salir antes de volver a entrar con un usuario diferente» | Se repitió el login (F5 o volver atrás) con un código de Google ya usado | Tocá **Cancelar**, cortá la terminal (Ctrl+C) y corré el comando de nuevo |
| Pegué y dice «formato distinto de <esquema>://token=…» | Se copió la barra de direcciones u otro texto | Copiá con clic derecho **el enlace azul** de la página «Confirmado» |
| «Retorno rechazado: transacción expirada» | Pasaron más de 10 minutos | Corré el comando de nuevo |
| «no corresponde a ninguna transacción activa» | El enlace es de otro intento (por ejemplo, de una pestaña vieja) | Usá el enlace de la página del intento actual, o empezá de nuevo |
| `IDENTITY_MISMATCH` («no coincide con la registrada en el perfil») | Entraste con otra cuenta de Google, asociada a otro usuario de Moodle | Repetí eligiendo `@udesa.edu.ar`. Sólo si el cambio es intencional: `--replace-identity` |
| «El Campus forzó el esquema moodlemobile» | UdeSA empezó a forzar el esquema de la app oficial | El login manual igual funciona. El retorno automático dejaría de ser viable sin tocar la app oficial |
| `SECRET_STORE_UNAVAILABLE` | No hay almacén seguro del sistema (keyring) | En Windows debería existir siempre; en Linux hace falta Secret Service ([CONFIGURACION_LOCAL.md](CONFIGURACION_LOCAL.md)) |
| `NETWORK_ERROR` o el Campus muestra un error propio | Red, Campus caído o un cambio en Moodle | Copiá el texto del error (**sin el enlace del token**) y revisalo con [AUTH_BROWSER.md](AUTH_BROWSER.md) |
| `El login necesita una terminal interactiva` | Se corrió por pipe o desde un agente | Correlo vos en una terminal |
| Ventana «No hay ningún login por navegador esperando el retorno» | Se abrió un enlace `udesacampusmcp://` sin un `auth login` esperando (o ya vencido) | Corré el comando de login y repetí |
| «Aviso: el esquema está registrado con otra ruta» | Se movió el proyecto o cambió Node | `node build/cli.js auth handler install` |
| El navegador no pregunta nada y la terminal no avanza | No se hizo clic izquierdo en el enlace azul (Chrome bloquea el intento automático), o el retorno automático no está instalado | Hacé clic izquierdo en el enlace; si igual no pregunta, copiá el enlace (clic derecho) y pegalo en la terminal, o instalá con `auth handler install` |

Opciones del comando: `--no-open` (no abre el navegador, sólo imprime el enlace de inicio), `--idp <id>` (otro proveedor del Campus; en UdeSA hay uno, el 4), `--scheme <esquema>` (por defecto `udesacampusmcp`).

## Después del login: ¿hay que tocar el servidor remoto?

- **Modo local** (Claude Code, Codex): usa la sesión enseguida. Si estaba abierto, puede que haga falta una conversación nueva.
- **Servidor de Vercel:** guarda su propia copia del token. Moodle reutiliza el token vigente de tu usuario (el login con Google devuelve **el mismo** que el de contraseña), así que normalmente no hay que hacer nada. Si alguna vez el remoto devuelve `AUTH_REQUIRED` (token vencido o revocado), después de este login corré:

  ```bash
  node build/cli.js remote push-token --profile udesa-docente
  ```

  ```bash
  vercel deploy --prod
  ```

## Si el token se expuso

Si el enlace `udesacampusmcp://token=…` terminó en un chat, una captura, un documento o una búsqueda, tratá el token como comprometido:

1. **En UdeSA no lo podés restablecer vos:** el Campus no ofrece «Claves de seguridad» (`/user/managetoken.php` responde 404). Pedile a la mesa de ayuda que revoque el token del servicio «Moodle mobile web service» de tu cuenta. Un login nuevo **no** sirve como rotación: devuelve el mismo token mientras siga vigente.
2. Cuando lo revoquen, iniciá sesión de nuevo (nativo o Google). Moodle emite un token nuevo y queda en el keyring.
3. Actualizá el servidor remoto: `node build/cli.js remote push-token --profile udesa-docente` y después `vercel deploy --prod`.
4. Borrá el rastro: la entrada del historial de Chrome y, si fue una búsqueda, la actividad en «Mi actividad» de Google.

El procedimiento general de incidentes está en [PROCESOS.md](PROCESOS.md#incidentes).

## Qué hace y qué no hace

- **No ve tu contraseña de Google ni la del Campus:** el login lo hacés en tu navegador. El MCP sólo recibe el token de Moodle que vos pegás.
- Valida el retorno antes de usarlo: que corresponda a este intento (hash con un valor aleatorio de un solo uso), que no haya vencido, que sea del Campus correcto y de tu misma cuenta de Moodle.
- Guarda el token en el Administrador de credenciales de Windows, nunca en archivos ni en el repo.
- `auth logout --local` borra la copia local; no cierra tu sesión de Google ni revoca el token en Moodle.

## Notas

- El retorno automático está implementado sólo para Windows. En macOS y Linux se usa el pegado manual.
- Windows agrega una barra final al enlace (`…==/`) al pasárselo al manejador; la CLI lo tolera sin aflojar la validación.

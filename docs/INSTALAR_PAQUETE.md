# Instalar el paquete precompilado

Este paquete ya trae todo compilado y las dependencias incluidas: **no hace falta npm ni internet para instalarlo**. Sirve cuando la red bloquea el registro de npm (por ejemplo, una red institucional con inspección TLS) o cuando no querés compilar.

Funciona en Windows (x64 y ARM), macOS (Intel y Apple Silicon) y Linux (x64 y ARM64, glibc o musl). Sólo necesitás **Node.js 22 o más nuevo** (`node --version`); si no lo tenés, bajalo de nodejs.org.

## 1. Descomprimir

Descomprimí el zip en una carpeta estable, por ejemplo `C:/Users/<usuario>/udesa-campus-mcp` o `~/udesa-campus-mcp`. En los comandos de abajo, `<ruta>` es esa carpeta (en Windows, con barras `/`).

Comprobación:

```bash
node <ruta>/build/cli.js
```

Tiene que mostrar la lista de comandos.

- **macOS:** si al iniciar sesión aparece un error al cargar `keyring.darwin-*.node`, quitale la marca de cuarentena del navegador a la carpeta: `xattr -dr com.apple.quarantine <ruta>`. La primera vez, macOS puede preguntar si `node` puede usar el Llavero: aceptá.
- **Linux:** el token se guarda en el Secret Service (GNOME Keyring o KWallet). En un servidor sin escritorio no hay almacén seguro, y el login se detiene antes de pedir la contraseña.

## 2. Iniciar sesión (lo hacés vos, en tu terminal)

```bash
node <ruta>/build/cli.js auth login --profile udesa-docente --method native
```

Pide usuario y contraseña del Campus. La contraseña no se guarda; el token queda en el almacén seguro del sistema (Administrador de credenciales, Llavero o Secret Service). Con cuenta de Google institucional, usá `--method browser`: [docs/LOGIN_GOOGLE.md](docs/LOGIN_GOOGLE.md).

Nunca pegues contraseñas, tokens ni enlaces de retorno en el chat con el agente.

Para comprobar que anda:

```bash
node <ruta>/build/cli.js diagnose --profile udesa-docente
```

## 3. Conectar el cliente

Usá la ruta **absoluta** de `node` (`where node` en Windows, `which node` en macOS y Linux): las apps de escritorio pueden no tener el `PATH` de tu terminal.

**Claude Code** (en Windows, desde Git Bash o `cmd`, no PowerShell):

```bash
claude mcp add udesa-campus --scope user -e CAMPUS_READ_ONLY=true -- <node> <ruta>/build/cli.js serve --profile udesa-docente
```

**Claude Desktop** (Configuración → Desarrollador → Editar configuración, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "udesa-campus": {
      "command": "<node>",
      "args": ["<ruta>/build/cli.js", "serve", "--profile", "udesa-docente"],
      "env": { "CAMPUS_READ_ONLY": "true" }
    }
  }
}
```

**Codex** y lecturas + escrituras (`serve-full --profile docente-completo`): [docs/CONFIGURACION_LOCAL.md](docs/CONFIGURACION_LOCAL.md).

## Actualizar

Bajá el zip nuevo y reemplazá la carpeta. El login no se repite: el token está en el almacén del sistema, no en la carpeta.

## Qué trae

`build/` (el servidor compilado), `profiles/`, `node_modules/` (sólo dependencias de producción, con los binarios del almacén de credenciales de cada plataforma), `docs/` y las licencias. Se armó con `node scripts/empaquetar.mjs` desde el repositorio; el archivo `.sha256` publicado junto al zip sirve para verificarlo.

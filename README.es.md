# 1min.ai Monaco Client

> 🌐 [日本語](README.md) | [English](README.en.md) | [中文](README.zh.md) | [한국어](README.ko.md) | [Español](README.es.md)

> [!WARNING]
> **Esta aplicación está diseñada para uso personal en entorno local (localhost/127.0.0.1) y un solo usuario.**
> Las funciones de `/api/fs/*` (operaciones del sistema de archivos) y ejecución de comandos del agente no incluyen protecciones de nivel empresarial como control de acceso basado en roles (RBAC), registro detallado de auditoría o ejecución en sandbox para escenarios multiusuario. **Nunca despliegue en servidores de internet público o entornos compartidos de desarrollo/staging.**
>
> **[IMPORTANTE] Advertencia de seguridad sobre ejecución de comandos OS del agente AI**
>
> - Al habilitar la ejecución de comandos OS mediante la función de agente (`ENABLE_COMMAND_EXECUTION=true`), existe el riesgo de que la AI ejecute código arbitrario (por ejemplo, instalar o ejecutar paquetes maliciosos).
> - Por defecto, ejecute con **`AGENT_AUTO_APPROVE=false`** y siempre verifique visualmente la seguridad del comando antes de la ejecución. Si establece `AGENT_AUTO_APPROVE=true`, úselo en un sandbox completamente aislado o entorno Docker.

Un cliente AI MVP para navegador construido con Monaco Editor + UI personalizada + API de 1min.ai.
Utiliza un servidor Express como BFF para evitar exponer la clave API de 1min.ai al frontend.

## Características

- Chat
- Selector de modelos con categorías (Flagship, Razonamiento, Rápido y ligero)
- Creación de conversaciones / reanudación con `conversationId`
- Extensión de chat mediante Web Search
- Generación de imágenes
- Editor de texto de imágenes
- Subida de imágenes mediante Asset API
- Integración de Monaco Editor
- Explicación / generación / refactorización de código
- Chat en línea con vista previa de aplicar/descartar
- Agente de codificación AI avanzado (visualización detallada del proceso de pensamiento, flujo de aprobación)
- Exploración y guardado de archivos del proyecto
- Arquitectura de retransmisión por servidor que mantiene las claves API fuera del frontend
- Protección robusta de rutas de archivo y seguridad (`fs-guard`)

## Requisitos

- Node.js 18+
- Clave API de 1min.ai
- Monaco Editor / marked / DOMPurify se copian automáticamente a `public/` al ejecutar `npm start`, por lo que no se necesita conexión a internet después de `npm install` (excepto para la carga de Google Fonts)

## Inicio rápido

```bash
cp .env.example .env
# Edite ONE_MIN_AI_API_KEY en .env
npm install
npm start
```

O en modo desarrollo con watch:

```bash
npm run dev
```

Después de iniciar, abra:

```text
http://localhost:3000
```

## Variables de entorno

| Variable                   | Requerida | Predeterminado     | Descripción                                                                         |
| -------------------------- | --------- | ------------------ | ----------------------------------------------------------------------------------- |
| `ONE_MIN_AI_API_KEY`       | Sí        | Ninguno            | Clave API de 1min.ai. Almacene solo en `.env`.                                      |
| `PORT`                     | No        | `3000`             | Puerto de escucha del servidor Express local.                                       |
| `NODE_ENV`                 | No        | `development`      | Establezca en `production` para ocultar trazas de pila y habilitar cookies seguras. |
| `MAX_FILE_SIZE`            | No        | `26214400`         | Límite de tamaño de subida de assets en bytes (predeterminado 25MB).                |
| `DEFAULT_CHAT_MODEL`       | No        | `gpt-4o-mini`      | Modelo predeterminado para chat y generación de código.                             |
| `DEFAULT_CODE_MODEL`       | No        | `qwen3-coder-plus` | Modelo predeterminado para generación de código.                                    |
| `DEFAULT_IMAGE_MODEL`      | No        | `gpt-image-2`      | Modelo predeterminado para generación de imágenes.                                  |
| `ENABLE_COMMAND_EXECUTION` | No        | `false`            | Habilitar ejecución de comandos del agente.                                         |
| `AGENT_AUTO_APPROVE`       | No        | `false`            | Permitir ejecución sin aprobación. Mantenga en false por defecto.                   |
| `AGENT_MAX_LOOPS`          | No        | `20`               | Máximo de iteraciones del bucle del agente (1-100).                                 |
| `LOG_LEVEL`                | No        | `info`             | Nivel de log (`error`, `warn`, `info`, `debug`).                                    |

## Uso

### Chat

1. Abra "Chat" desde el menú izquierdo.
2. Seleccione un modelo.
3. Escriba un mensaje y envíelo.
4. Para usar el historial de conversación, haga clic en "Crear nueva conversación" e ingrese el ID devuelto en `conversationId`.

### Generación de imágenes / Edición de texto

1. Abra "Gen de imagen / Edición de texto" desde el menú izquierdo.
2. Para generación de imágenes, ingrese el prompt, modelo, relación de aspecto y cantidad.
3. Para el editor de texto de imágenes, suba una imagen fuente e ingrese la clave asset devuelta o una URL de imagen existente.
4. Especifique el prompt de edición, modelo, tamaño de salida, calidad, cantidad, etc. y haga clic en "Editar imagen".

### Asistencia de codificación

1. Abra "Codificación" desde el menú izquierdo.
2. Abra un archivo desde el árbol de archivos.
3. Ingrese instrucciones en el panel de AI Coding a la derecha y presione "Ejecutar".
4. Use "Aplicar primer bloque de código al editor" para aplicar los resultados al editor.
5. `Ctrl+S` para guardar, `Ctrl+I` para abrir chat en línea.

## Notas

- No commitee `.env` a Git. Si lo commitea accidentalmente, regenere siempre su clave API en 1min.ai.
- `/api/fs/*` es para desarrollo local. Para entornos públicos, refuerce la autenticación, protección CSRF, registro de auditoría, sandbox de ejecución y políticas de rutas protegidas.
- Esto es una versión MVP. Para uso en producción, agregue autenticación, limitación de velocidad, registro de auditoría, ejecución en sandbox, protección CSRF, etc.

## Licencia

MIT License

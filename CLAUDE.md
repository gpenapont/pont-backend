# TeVende (antes "PONT Ventas")

Plataforma multi-tenant de agentes de venta por chat con IA. Cada negocio cliente conecta su catálogo, su WhatsApp y sus medios de pago, y un agente (Claude Haiku) atiende a sus clientes finales por chat web y/o WhatsApp, tomando pedidos automáticamente.

Es un producto separado de NOK (otro producto de Gonzalo Peña / PONT LAT) — infraestructura, base de datos y número de WhatsApp completamente independientes.

## Stack

- **Backend**: Node.js + Express, un solo archivo `server.js`, desplegado en **Railway**.
- **Base de datos**: Postgres en **Supabase**. Una sola tabla `businesses` central con muchas columnas (multi-tenant por fila, no por schema).
- **Frontend**: HTML/JS vanilla sin build step, servido como archivos estáticos desde **Netlify** (sitio único `pont-venta-ia.netlify.app`, todos los negocios comparten el mismo sitio, diferenciados por `?negocio=slug` en la URL).
- **LLM**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) vía API de Anthropic directa (fetch, sin SDK).
- Todas las integraciones externas (Meta/WhatsApp, Mercado Pago, Resend, reCAPTCHA) están hechas con `fetch()` nativo, sin SDKs — excepto Webpay, que sí usa `transbank-sdk` (cargado dinámicamente con `await import()` solo cuando se necesita).

## Archivos del frontend (todos en la misma carpeta/sitio de Netlify)

- `index.html` — el chat que ven los clientes finales. Lee el negocio desde `?negocio=slug`.
- `ventas.html` — panel de administración de cada negocio ("TeVende"). Login con clave propia del negocio (`dashboard_password`). Cuatro pestañas: Pedidos, Configuración, Catálogo, Tu suscripción.
- `signup.html` — autoregistro público de negocios nuevos. Requiere correo verificado (link por email vía Resend) + reCAPTCHA v2. Ya no usa código de invitación.
- `admin.html` — panel solo para Gonzalo (clave `ADMIN_PASSWORD`, distinta de la de cada negocio). Lista todos los negocios, sus links, estado de suscripción, fecha de último pago (editable a mano), y estado de boleta/factura.

## Rutas clave del backend

Públicas:
- `GET /api/business/:slug` — info pública del negocio (nombre, saludo, catálogo, logo).
- `POST /api/chat/:slug` — mensaje del chat web.
- `POST /api/business/signup` — autoregistro (nombre, correo, clave, captcha).
- `GET /api/business/verify-email` — confirma el correo desde el link del email. **IMPORTANTE: esta ruta está registrada ANTES que `/api/business/:slug` en el código — si se mueve después, Express la confunde con un slug y deja de funcionar** (bug real que ya pasó una vez).
- `GET|POST /api/whatsapp/webhook` — verificación y mensajes entrantes de WhatsApp.
- `POST /api/mercadopago/webhook` — confirmaciones de suscripción.

Protegidas con `x-dashboard-key` (clave del negocio, **o** la de `ADMIN_PASSWORD` como bypass universal):
- `GET/PUT /api/business/:slug/settings` — configuración general.
- `PUT /api/business/:slug/logo` — logo propio (ruta separada de settings a propósito, para no arriesgar pisar el resto de la config).
- CRUD de catálogo, incluyendo `PUT /api/business/:slug/menu-items/bulk` (reemplazo masivo pegando texto tipo Excel).
- WhatsApp: conexión manual y Embedded Signup (`/whatsapp/connect`).
- Suscripción Mercado Pago: crear checkout, etc.

Solo con `x-admin-key` = `ADMIN_PASSWORD`:
- `GET /api/admin/businesses`, `PUT .../last-payment`, `PUT .../invoice-status`.

## Variables de entorno (Railway)

```
ANTHROPIC_API_KEY
DATABASE_URL
ALLOWED_ORIGIN
PUBLIC_BACKEND_URL          # https://pont-backend-production.up.railway.app
FRONTEND_APP_URL            # https://pont-venta-ia.netlify.app
WHATSAPP_VERIFY_TOKEN
FACEBOOK_APP_ID / FACEBOOK_APP_SECRET   # para Embedded Signup
MP_ACCESS_TOKEN             # Mercado Pago (hoy en modo TEST-...)
ADMIN_PASSWORD
RECAPTCHA_SECRET_KEY
RESEND_API_KEY
RESEND_FROM                 # TeVende <noreply@mail.pont.lat> — dominio ya verificado
```

## Estado de cada integración (a la fecha)

- **Webpay (Transbank)**: funcionando en sandbox. Cada negocio carga sus propias credenciales (o queda en modo prueba si las deja vacías). Sirve para que CADA NEGOCIO le cobre a SUS clientes.
- **Mercado Pago Suscripciones**: funcionando con credenciales TEST. Es PONT/TeVende cobrándole $5.000/mes a cada negocio (lo opuesto a Webpay). No usa "preapproval_plan_id" — el preapproval se crea con `auto_recurring` inline, porque el modelo con plan exige capturar tarjeta uno mismo. **Pendiente**: Gonzalo está esperando validación de Mercado Pago para pasar a credenciales de producción.
- **WhatsApp (Cloud API + Embedded Signup)**: conexión manual funciona. El botón de Embedded Signup ("Conectar mi WhatsApp con Facebook") tiene el código listo pero requiere que la app de Meta ("pontia", App ID 1577039840784715) esté aprobada como Tech Provider — **ya se envió a revisión de Meta** (App Review), pendiente de aprobación (puede tardar días/semanas). Hasta que se apruebe, el botón solo funciona para Gonzalo mismo como admin de la app.
- **Registro con verificación de correo + captcha**: funcionando de punta a punta (dominio `mail.pont.lat` verificado en Resend).
- **Exportar pedidos**: cada negocio puede descargar sus pedidos como CSV (se abre directo en Excel) desde el botón en la pestaña Pedidos — se generaba antes vía Google Sheets, pero Google exige que la app esté hospedada en un dominio propio (no `netlify.app`) para verificar esa integración con OAuth, así que se reemplazó por esta exportación local, sin dependencias externas.

## Modelo de negocio / lógica particular

- El agente se desactiva automáticamente **5 días después de `last_payment_date`** (columna editable a mano desde `admin.html`, o autoactualizada cuando Mercado Pago confirma un pago). Si `last_payment_date` es null (negocios viejos), no se bloquea — es retrocompatible a propósito.
- Los pedidos nunca se borran de verdad — "Eliminar" solo cambia el `status` a `'eliminado'`, para no perder el historial ni romper la vista de un dashboard que ya lo tenía cargado.
- Multi-tenant: un negocio nuevo NO necesita un sitio de Netlify propio — todo vive en la fila de `businesses` y se accede vía `?negocio=slug`. Solo quedan dos negocios en sitios propios legacy (`helenedef.netlify.app`, `sodastreamcl.netlify.app`) que podrían migrarse o borrarse.

## Convenciones de estilo del código

- Comentarios en español, explicando el "por qué" de decisiones no obvias (ej. por qué una ruta va antes que otra, por qué se usa `coalesce()` en un UPDATE).
- Sin frameworks de frontend — HTML/CSS/JS plano en cada archivo, con un único `<script>` por archivo.
- Colores de marca: navy `#102738`, coral `#E64F3F`, mint `#C1E1D6`, gray `#E3E4E3`.

## Pendientes conocidos (a completar)

- [ ] Migrar o eliminar los sitios legacy de Hélène y Soda Stream en Netlify.
- [ ] Terminar de habilitar Mercado Pago en producción cuando llegue la validación.
- [ ] Esperar aprobación de Meta App Review para Embedded Signup abierto a todos los negocios.
- [ ] Guía de video/screencast de WhatsApp Embedded Signup para clientes finales (ya existe un docx básico: `guia-conectar-whatsapp-clientes.docx`).

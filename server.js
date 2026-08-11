// Backend propio de PONT para el agente de pedidos.
// Reemplaza la llamada directa a api.anthropic.com que hacía el artifact:
// ahora el frontend le habla a ESTE servidor, y este servidor (con tu API key,
// que nunca se expone al navegador) le habla a Claude.
//
// npm install express cors pg dotenv
// node server.js

import express from "express";
import cors from "cors";
import pkg from "pg";
import crypto from "crypto";
import "dotenv/config";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json({ limit: "5mb" })); // el límite por defecto es muy chico para subir un logo
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const FACEBOOK_APP_ID = (process.env.FACEBOOK_APP_ID || "").trim();
const FACEBOOK_APP_SECRET = (process.env.FACEBOOK_APP_SECRET || "").trim();
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || "").trim();
const MP_PLAN_ID = (process.env.MP_PLAN_ID || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const RECAPTCHA_SECRET_KEY = (process.env.RECAPTCHA_SECRET_KEY || "").trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = (process.env.RESEND_FROM || "TeVende <onboarding@resend.dev>").trim();

async function sendVerificationEmail(email, businessName, token) {
  const verifyUrl = `${process.env.PUBLIC_BACKEND_URL || ""}/api/business/verify-email?token=${token}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: "Confirma tu cuenta en TeVende",
      html: `
        <p>Hola,</p>
        <p>Falta un paso para activar la cuenta de <b>${businessName}</b> en TeVende.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;background:#E64F3F;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold;">Confirmar mi cuenta</a></p>
        <p>Si el botón no funciona, copia y pega este link en tu navegador:<br/>${verifyUrl}</p>
      `,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Error de Resend: " + err);
  }
}
const SHEET_HEADERS = ["Fecha", "Cliente", "Productos", "Total", "Entrega", "Estado", "ID Pedido"];

// Cambia el refresh_token guardado por un access_token válido (dura 1 hora, así que se pide de nuevo cada vez).
async function getGoogleAccessToken(business) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: business.google_refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("No se pudo refrescar el token de Google: " + JSON.stringify(data));
  return data.access_token;
}

// Escribe o actualiza la fila de un pedido en la planilla del negocio. Nunca revienta el flujo
// del chat si algo falla — se llama siempre "en paralelo", sin bloquear la respuesta al cliente.
async function syncOrderToSheet(business, order) {
  if (!business.google_sheets_enabled || !business.google_refresh_token || !business.google_spreadsheet_id) return;

  const accessToken = await getGoogleAccessToken(business);
  const sheetId = business.google_spreadsheet_id;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  // Busca si ya existe una fila para este pedido (columna G = ID Pedido).
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Pedidos!G2:G10000`,
    { headers }
  );
  const getData = await getRes.json();
  const ids = (getData.values || []).map((r) => r[0]);
  const rowIndex = ids.findIndex((id) => id === order.id);

  const items = (order.items || []).map((it) => `${it.qty}x ${it.name}`).join(", ");
  const entrega = order.delivery_type === "despacho" ? `Despacho: ${order.delivery_address || ""}` : (order.delivery_type === "retiro" ? "Retiro" : "");
  const row = [
    new Date(order.created_at || Date.now()).toLocaleString("es-CL"),
    order.customer_name || "",
    items,
    order.total || 0,
    entrega,
    order.status,
    order.id,
  ];

  if (rowIndex === -1) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Pedidos!A1:append?valueInputOption=USER_ENTERED`,
      { method: "POST", headers, body: JSON.stringify({ values: [row] }) }
    );
  } else {
    const sheetRow = rowIndex + 2; // +2: la fila 1 es encabezado, y los índices de Sheets empiezan en 1
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Pedidos!A${sheetRow}:G${sheetRow}?valueInputOption=USER_ENTERED`,
      { method: "PUT", headers, body: JSON.stringify({ values: [row] }) }
    );
  }
}

// Nunca dejar que un problema con Sheets rompa el flujo real del pedido.
function syncOrderToSheetSafe(business, order) {
  if (!order) return;
  syncOrderToSheet(business, order).catch((e) => console.error("Error sincronizando con Google Sheets:", e));
}

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// URL pública de ESTE backend (para armar el link de vuelta que le pasamos a Transbank).
// Configúrala en las variables de entorno de Railway.
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || "https://pont-backend-production.up.railway.app";

// transbank-sdk se carga solo cuando realmente se necesita (no al iniciar el servidor).
// Así, si algo falla con esa librería, solo falla la función de pago con Webpay,
// nunca tumba el resto del backend (chats, pedidos, todo lo demás sigue andando).
let _transbank = null;
async function getTransbank() {
  if (!_transbank) {
    const mod = await import("transbank-sdk");
    // transbank-sdk es CommonJS; hay que leer sus propiedades desde .default,
    // no confiar en los named exports sintéticos (algunos, como 'Environment', no siempre se detectan bien).
    _transbank = mod.default || mod;
  }
  return _transbank;
}

// Arma la configuración de Transbank: usa las credenciales propias del negocio si las tiene
// cargadas (ambiente de producción), o las credenciales de prueba oficiales de Transbank
// si no (ambiente de integración). No usamos buildForIntegration() porque en esta versión
// del SDK falla con 401 — se comprobó explícitamente que armar Options a mano sí funciona.
async function getWebpayTransaction(business) {
  const { WebpayPlus, Options, Environment, IntegrationCommerceCodes, IntegrationApiKeys } = await getTransbank();
  const commerceCode = business.webpay_commerce_code || IntegrationCommerceCodes.WEBPAY_PLUS;
  const apiKey = business.webpay_api_key || IntegrationApiKeys.WEBPAY;
  const environment = business.webpay_commerce_code ? Environment.Production : Environment.Integration;
  return { tx: new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment)), environment };
}

// Crea la transacción en Transbank y devuelve el link que hay que mandarle al cliente.
async function createWebpayTransaction(business, order) {
  const { tx } = await getWebpayTransaction(business);

  const buyOrder = order.id.replace(/-/g, "").slice(0, 20);
  const returnUrl = `${PUBLIC_BACKEND_URL}/api/webpay/return`;
  const response = await tx.create(buyOrder, order.conversation_id, order.total, returnUrl);

  await pool.query("update orders set webpay_token = $1 where id = $2", [response.token, order.id]);

  return `${PUBLIC_BACKEND_URL}/api/webpay/redirect/${response.token}`;
}

function formatBankDetails(b) {
  return [
    `Banco: ${b.bank_name || "[completar]"}`,
    `Tipo de cuenta: ${b.bank_account_type || "[completar]"}`,
    `N° de cuenta: ${b.bank_account_number || "[completar]"}`,
    `RUT: ${b.bank_rut || "[completar]"}`,
    `Enviar comprobante a: ${b.bank_email || "[completar]"}`,
  ].join("\n");
}

// Arma las instrucciones de entrega según lo que el negocio activó en Catálogo.
// Por defecto (columnas null, negocios de antes de este cambio) se tratan como
// activadas ambas, para no cambiar el comportamiento de negocios ya en marcha.
function buildDeliverySection(b) {
  const pickup = b.pickup_enabled !== false;
  const delivery = b.delivery_enabled !== false;
  const pickupAddress = b.pickup_address || null;
  const deliveryRules = b.delivery_rules || null;

  if (pickup && delivery) {
    return `Antes de cerrar el pedido, pregunta si es despacho a domicilio o retiro en tienda.${pickupAddress ? ` El retiro en tienda es en: ${pickupAddress}.` : ""}${deliveryRules ? ` Reglas de despacho a domicilio del negocio: ${deliveryRules}.` : ""} Si no sabes el nombre del cliente (revisa la información conocida más arriba), pregúntaselo en ese mismo mensaje, junto con la pregunta de entrega — por ejemplo: "¿Me confirmas tu nombre, y si prefieres despacho a domicilio o retiro en tienda?". No lo dejes para después ni lo omitas. Si es despacho y no tienes una dirección registrada, pide también dirección y comuna.`;
  }
  if (pickup && !delivery) {
    return `Este negocio solo ofrece retiro en tienda, no hace despacho a domicilio — no ofrezcas despacho como opción.${pickupAddress ? ` El retiro es en: ${pickupAddress}, coméntaselo al cliente cuando corresponda.` : ""} Si no sabes el nombre del cliente, pregúntaselo en algún momento natural antes de cerrar el pedido. Antes de cerrar el pedido, confirma con el cliente que retirará en tienda.`;
  }
  if (!pickup && delivery) {
    return `Este negocio solo hace despacho a domicilio, no ofrece retiro en tienda — no ofrezcas retiro como opción.${deliveryRules ? ` Reglas de despacho a domicilio del negocio: ${deliveryRules}.` : ""} Antes de cerrar el pedido, pide la dirección y comuna de despacho (si no la tienes ya registrada, revisa la información conocida más arriba) y el nombre del cliente si no lo sabes.`;
  }
  return `Este negocio no tiene un método de entrega configurado — no preguntes por tipo de entrega, solo confirma el pedido y el nombre del cliente si no lo sabes.`;
}

function buildSystemPrompt(business, menuItems, customer) {
  const menuText = menuItems
    .map((i) => `- ${i.name}: $${i.price.toLocaleString("es-CL")}${i.has_image ? ` [id:${i.id}, tiene foto disponible]` : ""}`)
    .join("\n");
  const hasAnyPhoto = menuItems.some((i) => i.has_image);
  const hasBankDetails = !!business.bank_account_number;
  const hasWebpay = !!business.webpay_enabled;

  let paymentSection;
  if (hasWebpay) {
    paymentSection = `- Una vez confirmado, dile que le vas a enviar un link de pago seguro (Webpay) y escribe exactamente el marcador [LINK_PAGO] en su propia línea (nunca inventes una URL). El pago se confirma automáticamente al pagar, no hace falta pedir comprobante.`;
  } else if (hasBankDetails) {
    paymentSection = `- Una vez confirmado, indica que el pago es por transferencia bancaria y comparte los datos escribiendo exactamente el marcador [DATOS_BANCARIOS] (nunca inventes un número de cuenta). Pide el comprobante.
- Avísale, con esos mismos datos, que tiene 24 horas para hacer la transferencia — si no llega el pago en ese plazo, el pedido se cancela automáticamente.
- Si el cliente dice que ya transfirió, agradece y explica que el equipo verificará el pago antes de preparar el pedido. Nunca confirmes tú que el pago fue recibido.`;
  } else {
    paymentSection = `- La forma de pago se coordina directamente al momento de la entrega o el intercambio. No inventes datos bancarios ni digital de pago que no tengas.`;
  }

  const knownName = customer && customer.name ? customer.name : null;
  const knownAddress = customer && customer.last_address ? customer.last_address : null;
  const customerSection = `Información que ya tienes de este cliente (de conversaciones o pedidos anteriores en este mismo canal):
- Nombre: ${knownName ? knownName : "todavía no lo sabes"}
- Última dirección de despacho usada: ${knownAddress ? knownAddress : "todavía no la sabes"}
${knownName ? "Ya sabes su nombre, no se lo vuelvas a preguntar; puedes usarlo para dirigirte a él o ella de forma natural, sin abusar." : "No sabes su nombre todavía — pregúntaselo en algún momento natural y temprano de la conversación (no como si fuera un formulario), para poder incluirlo en el pedido."}
${knownAddress ? `Ya tienes una dirección de despacho registrada. Si el cliente pide despacho, NO se la vuelvas a preguntar — menciónala directamente en el resumen (por ejemplo: "despacho a ${knownAddress}, ¿sigue siendo esa dirección?") y solo pide una nueva si te dice que cambió.` : ""}`;

  return `Eres el agente de pedidos de ${business.name}. Los clientes te escriben online, desde el sitio web o un link compartido.

Importante: en la pantalla ya se le mostró este saludo al cliente antes de que escribiera, así que su primer mensaje puede ser una respuesta directa a lo que ahí se pregunta — interprétalo con ese contexto, no como un mensaje aislado. No vuelvas a saludar ni a presentar el negocio de nuevo en tu primera respuesta.

Saludo que ya vio el cliente: "${business.greeting || ""}"

${customerSection}

${business.system_prompt_extra || ""}

Catálogo disponible (precios en CLP):
${menuText}

Tu trabajo:
- Ayudar al cliente a elegir productos y calcular el total.
- Si el negocio especificó algún costo de despacho en sus instrucciones propias (más arriba), y el cliente elige despacho a domicilio, agrégalo como un ítem más en la lista de productos (por ejemplo "Despacho a domicilio" con su precio), para que quede visible en el desglose y no escondido dentro del total. Si el negocio dice que el despacho se cotiza aparte sin dar un monto fijo, no inventes un número — dilo así de claro.
- Responder en español neutro, amable pero sin modismos chilenos informales (nada de "bacán", "al tiro", "cachai", "po") y sin sonar tampoco excesivamente formal o robótico. Mantén las respuestas razonablemente breves, salvo que las instrucciones del negocio (más arriba) pidan un estilo más extenso, como explicaciones o recomendaciones detalladas. Sin markdown ni asteriscos.
- Si el cliente indica que no quiere agregar nada más (por ejemplo "nada más", "eso es todo", "solo eso", "no gracias"), no vuelvas a preguntar si quiere algo más. Avanza directo al siguiente paso: si falta el tipo de entrega, pregúntalo; si ya lo tienes, resume el pedido completo y pide confirmación.
${hasAnyPhoto ? `- Algunos productos del catálogo tienen foto disponible (marcados con "tiene foto disponible" y su id). Si el cliente pide ver una foto, o si ayuda mostrarla al recomendar ese producto, escribe el marcador [FOTO:<id>] en su propia línea, usando el id exacto que aparece junto al producto — nunca inventes un id ni muestres fotos de productos que no la tengan marcada. Puedes incluir varios marcadores, uno por línea, si el cliente pide ver más de un producto.` : ""}
- ${buildDeliverySection(business)}
- Después resume lo que llevan, el nombre del cliente si lo sabes, el tipo de entrega con su dirección si aplica, y pregunta si está todo correcto.
- Marcar el pedido como confirmado solo cuando el cliente lo confirme explícitamente.
${paymentSection}

Formato obligatorio de cada respuesta:
Primero tu respuesta al cliente en texto plano — esta parte nunca puede estar vacía, ni siquiera al confirmar el pedido, siempre debe haber un mensaje visible para el cliente. Después, en una línea aparte, agrega exactamente un bloque con el estado del pedido, así:
<order>{"customer_name":"...","items":[{"name":"...","qty":1,"price":0}],"total":0,"delivery":{"type":"despacho","address":"..."},"payment":{"status":"pendiente"},"confirmed":false}</order>

El campo customer_name debe llevar el nombre del cliente apenas lo sepas (si ya lo sabías de antes, repítelo igual en cada bloque). Si aún no lo sabes, usa null.
El campo payment.status puede ser: null, "pendiente" o "cliente_avisa_transferencia" (usa null si este negocio no cobra por transferencia).
Si aún no saben el tipo de entrega, usa "delivery":null. Si aún no han pedido nada, usa items vacío y total 0. Este bloque nunca lo ve el cliente. Nunca lo omitas.`;
}

function deriveOrderStatus(parsedOrder) {
  if (!parsedOrder.confirmed) return "draft";
  if (parsedOrder.payment && parsedOrder.payment.status === "cliente_avisa_transferencia") return "pago_avisado";
  return "confirmado";
}

// Endpoint público: lo consulta el frontend genérico al cargar, para saber
// el nombre, el saludo y el catálogo del negocio. Nunca expone system_prompt_extra ni datos bancarios.
// El link del correo de verificación llega aquí. Confirma el correo y manda de vuelta al sitio,
// que ahí sí muestra los links del negocio ya activado.
// IMPORTANTE: esta ruta va ANTES de "/api/business/:slug" — si fuera después, Express
// interpretaría "verify-email" como si fuera un slug y nunca llegaría aquí.
app.get("/api/business/verify-email", async (req, res) => {
  const { token } = req.query;
  const redirectBase = process.env.FRONTEND_APP_URL || "";
  if (!token) return res.redirect(`${redirectBase}/signup.html?verify=error`);

  const { rows } = await pool.query("select slug from businesses where email_verify_token = $1", [token]);
  const business = rows[0];
  if (!business) return res.redirect(`${redirectBase}/signup.html?verify=error`);

  await pool.query(
    "update businesses set email_verified = true, email_verify_token = null where slug = $1",
    [business.slug]
  );
  res.redirect(`${redirectBase}/signup.html?verify=ok&negocio=${business.slug}`);
});

app.get("/api/business/:slug", async (req, res) => {
  const { rows: businessRows } = await pool.query(
    "select id, slug, name, greeting, logo_data from businesses where slug = $1",
    [req.params.slug]
  );
  const business = businessRows[0];
  if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

  const { rows: menuItems } = await pool.query(
    "select name, price, category from menu_items where business_id = $1 and active = true order by category, name",
    [business.id]
  );
  res.json({ slug: business.slug, name: business.name, greeting: business.greeting, logoData: business.logo_data, menuItems });
});

// Autoregistro: crea un negocio nuevo sin intervención manual. Protegido con captcha (para que no
// sea un bot) y verificación de correo (para que sea un correo real) — no con un código que Gonzalo
// tenga que repartir a mano, así escala sin que él intervenga en cada registro.
app.post("/api/business/signup", async (req, res) => {
  const { name, email, password, captchaToken } = req.body;
  if (!name || !name.trim() || !email || !email.trim() || !password || !password.trim()) {
    return res.status(400).json({ error: "Falta el nombre del negocio, el correo o la clave" });
  }

  if (RECAPTCHA_SECRET_KEY) {
    const captchaRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET_KEY, response: captchaToken || "" }),
    });
    const captchaData = await captchaRes.json();
    if (!captchaData.success) {
      return res.status(400).json({ error: "No pudimos verificar que no eres un robot. Intenta de nuevo." });
    }
  }

  const baseSlug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "negocio";

  let slug = baseSlug;
  let suffix = 1;
  while (true) {
    const { rows } = await pool.query("select 1 from businesses where slug = $1", [slug]);
    if (!rows[0]) break;
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const verifyToken = crypto.randomBytes(24).toString("hex");

  await pool.query(
    `insert into businesses (slug, name, dashboard_password, greeting, email, email_verified, email_verify_token)
     values ($1, $2, $3, $4, $5, false, $6)`,
    [
      slug,
      name.trim(),
      password.trim(),
      `¡Bienvenido a ${name.trim()}! Cuéntanos qué buscas y te ayudamos a encontrarlo.`,
      email.trim(),
      verifyToken,
    ]
  );

  try {
    await sendVerificationEmail(email.trim(), name.trim(), verifyToken);
  } catch (e) {
    console.error("Error enviando correo de verificación:", e);
    return res.status(502).json({ error: "No pudimos enviarte el correo de verificación. Intenta de nuevo." });
  }

  res.json({ pendingVerification: true, email: email.trim() });
});

// El link del correo de verificación llega aquí. Confirma el correo y manda de vuelta al sitio,
// que ahí sí muestra los links del negocio ya activado.


// Helper compartido: busca el negocio por slug y valida la clave del panel (header x-dashboard-key).
// Devuelve la fila del negocio si todo bien, o null y ya responde el error si no.
async function getBusinessWithAuth(req, res) {
  const { rows } = await pool.query("select * from businesses where slug = $1", [req.params.slug]);
  const business = rows[0];
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return null;
  }
  const isAdmin = ADMIN_PASSWORD && req.headers["x-dashboard-key"] === ADMIN_PASSWORD;
  if (business.dashboard_password && req.headers["x-dashboard-key"] !== business.dashboard_password && !isAdmin) {
    res.status(401).json({ error: "Clave incorrecta" });
    return null;
  }
  if (business.email && !business.email_verified) {
    res.status(403).json({ error: "Todavía no confirmaste tu correo. Revisa tu bandeja de entrada." });
    return null;
  }
  return business;
}

// Panel de configuración: el negocio ve y edita su saludo, instrucciones, datos bancarios y catálogo.
app.get("/api/business/:slug/settings", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows: menuItems } = await pool.query(
    "select id, name, price, category, active, image_data is not null as has_image from menu_items where business_id = $1 order by category, name",
    [business.id]
  );
  res.json({
    name: business.name,
    greeting: business.greeting,
    system_prompt_extra: business.system_prompt_extra,
    bank_name: business.bank_name,
    bank_account_type: business.bank_account_type,
    bank_account_number: business.bank_account_number,
    bank_rut: business.bank_rut,
    bank_email: business.bank_email,
    webpay_enabled: business.webpay_enabled,
    webpay_commerce_code: business.webpay_commerce_code,
    webpay_api_key: business.webpay_api_key,
    whatsapp_phone_number_id: business.whatsapp_phone_number_id,
    whatsapp_access_token: business.whatsapp_access_token,
    subscription_status: business.subscription_status,
    last_payment_date: business.last_payment_date,
    mp_checkout_url: business.mp_checkout_url,
    logo_data: business.logo_data,
    google_sheets_enabled: business.google_sheets_enabled,
    google_spreadsheet_url: business.google_spreadsheet_url,
    google_email: business.google_email,
    bot_paused: business.bot_paused,
    pause_schedule_enabled: business.pause_schedule_enabled,
    pause_schedule: business.pause_schedule,
    pickup_enabled: business.pickup_enabled !== false,
    pickup_address: business.pickup_address,
    delivery_enabled: business.delivery_enabled !== false,
    delivery_rules: business.delivery_rules,
    menuItems,
  });
});

// Ruta dedicada solo para el logo, separada de settings general para no arriesgar
// pisar el resto de la configuración cuando se sube una imagen nueva.
app.put("/api/business/:slug/logo", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;
  const { logo_data } = req.body;
  await pool.query("update businesses set logo_data=$1 where id=$2", [logo_data || null, business.id]);
  res.json({ saved: true });
});

app.put("/api/business/:slug/settings", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const {
    greeting, system_prompt_extra, bank_name, bank_account_type, bank_account_number, bank_rut, bank_email,
    webpay_enabled, webpay_commerce_code, webpay_api_key,
    whatsapp_phone_number_id, whatsapp_access_token,
    bot_paused, pause_schedule_enabled, pause_schedule,
    pickup_enabled, pickup_address, delivery_enabled, delivery_rules,
  } = req.body;
  await pool.query(
    `update businesses set greeting=$1, system_prompt_extra=$2, bank_name=$3, bank_account_type=$4,
     bank_account_number=$5, bank_rut=$6, bank_email=$7, webpay_enabled=$8, webpay_commerce_code=$9, webpay_api_key=$10,
     whatsapp_phone_number_id=$11, whatsapp_access_token=$12, bot_paused=$13, pause_schedule_enabled=$14, pause_schedule=$15,
     pickup_enabled=$16, pickup_address=$17, delivery_enabled=$18, delivery_rules=$19
     where id=$20`,
    [greeting, system_prompt_extra, bank_name, bank_account_type, bank_account_number, bank_rut, bank_email,
     !!webpay_enabled, webpay_commerce_code || null, webpay_api_key || null,
     whatsapp_phone_number_id || null, whatsapp_access_token || null,
     !!bot_paused, !!pause_schedule_enabled, JSON.stringify(pause_schedule || {}),
     !!pickup_enabled, pickup_address || null, !!delivery_enabled, delivery_rules || null, business.id]
  );
  res.json({ saved: true });
});

app.post("/api/business/:slug/menu-items", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { name, price, category } = req.body;
  const { rows } = await pool.query(
    "insert into menu_items (business_id, name, price, category) values ($1,$2,$3,$4) returning *",
    [business.id, name, price, category || null]
  );
  res.json(rows[0]);
});

app.put("/api/business/:slug/menu-items/:itemId", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { name, price, category, active } = req.body;
  const { rows } = await pool.query(
    "update menu_items set name=$1, price=$2, category=$3, active=$4 where id=$5 and business_id=$6 returning *",
    [name, price, category || null, active, req.params.itemId, business.id]
  );
  res.json(rows[0]);
});

app.delete("/api/business/:slug/menu-items/:itemId", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  await pool.query("delete from menu_items where id=$1 and business_id=$2", [req.params.itemId, business.id]);
  res.json({ deleted: true });
});

// Ruta dedicada solo para la foto del producto, separada del resto para no arriesgar pisar
// nombre/precio/categoría al subir una imagen (mismo patrón que el logo del negocio).
app.put("/api/business/:slug/menu-items/:itemId/image", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;
  const { image_data } = req.body;
  try {
    await pool.query("update menu_items set image_data=$1 where id=$2 and business_id=$3", [
      image_data || null,
      req.params.itemId,
      business.id,
    ]);
    res.json({ saved: true });
  } catch (e) {
    console.error("Error guardando la foto del producto:", e);
    res.status(500).json({ error: "No se pudo guardar la foto" });
  }
});

// Sirve la foto del producto en crudo (sin auth: la necesitan tanto el chat web público
// como los servidores de WhatsApp para descargarla al mandarla como imagen nativa).
app.get("/api/business/:slug/menu-items/:itemId/image", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select mi.image_data from menu_items mi join businesses b on b.id = mi.business_id
       where b.slug = $1 and mi.id = $2`,
      [req.params.slug, req.params.itemId]
    );
    const imageData = rows[0] && rows[0].image_data;
    const match = imageData && imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return res.status(404).send("Sin imagen");
    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(match[2], "base64"));
  } catch (e) {
    console.error("Error sirviendo la foto del producto:", e);
    res.status(500).send("Error interno");
  }
});

// Interpreta texto pegado con un producto por línea: "Nombre, Precio, Categoría" o el mismo
// formato separado por tabulaciones (lo que queda al copiar y pegar directo desde Excel o Sheets).
function parseCatalogText(text) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const parts = line.includes("\t") ? line.split("\t") : line.split(",");
    const name = (parts[0] || "").trim();
    const priceDigits = (parts[1] || "").replace(/[^\d]/g, "");
    const price = parseInt(priceDigits, 10);
    const category = (parts[2] || "").trim() || null;
    if (name && price) items.push({ name, price, category });
  }
  return items;
}

// Reemplaza TODO el catálogo del negocio de una sola vez, a partir de texto pegado
// (ideal para un cliente básico: copia su lista desde Excel/Sheets y la pega directo).
app.put("/api/business/:slug/menu-items/bulk", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const items = parseCatalogText(req.body.text);
  if (items.length === 0) {
    return res.status(400).json({ error: "No se reconoció ningún producto en el texto pegado" });
  }

  await pool.query("delete from menu_items where business_id = $1", [business.id]);
  for (const item of items) {
    await pool.query("insert into menu_items (business_id, name, price, category) values ($1,$2,$3,$4)", [
      business.id,
      item.name,
      item.price,
      item.category,
    ]);
  }
  res.json({ replaced: items.length });
});

// Recupera una conversación existente por sessionId (para restaurar el chat al recargar la página).
app.get("/api/chat/:slug/history", async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "Falta sessionId" });

  const { rows: businessRows } = await pool.query("select id from businesses where slug = $1", [req.params.slug]);
  const business = businessRows[0];
  if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

  const { rows: convRows } = await pool.query(
    "select * from conversations where business_id = $1 and session_id = $2",
    [business.id, sessionId]
  );
  if (!convRows[0]) return res.json({ messages: [], order: null });

  const { rows: messages } = await pool.query(
    "select role, content from messages where conversation_id = $1 order by created_at asc",
    [convRows[0].id]
  );
  const { rows: openOrders } = await pool.query(
    "select * from orders where conversation_id = $1 and status not in ('pago_verificado', 'cancelado') order by created_at desc limit 1",
    [convRows[0].id]
  );
  res.json({ messages, order: openOrders[0] || null });
});

// Procesa un mensaje entrante y devuelve la respuesta — la usan tanto el chat web
// como WhatsApp, así la lógica de negocio vive en un solo lugar.
// El agente se desactiva 5 días después del último pago registrado. Si nunca se registró un
// pago (negocios de antes de este cambio), no se bloquea — evita romper negocios ya activos.
const DIAS_GRACIA_SIN_PAGO = 5;
function isAgentInactive(business) {
  if (!business.last_payment_date) return false;
  const diasSinPago = (Date.now() - new Date(business.last_payment_date).getTime()) / (1000 * 60 * 60 * 24);
  return diasSinPago > DIAS_GRACIA_SIN_PAGO;
}

async function processMessage(business, sessionId, message) {
  if (isAgentInactive(business)) {
    return {
      replyText: "Este servicio está temporalmente pausado. Contáctanos directamente para más información.",
      order: null,
    };
  }

  const { rows: menuItems } = await pool.query(
    "select id, name, price, image_data is not null as has_image from menu_items where business_id = $1 and active = true order by category, name",
    [business.id]
  );

  const { rows: customerRows } = await pool.query(
    "select * from customers where business_id = $1 and session_id = $2",
    [business.id, sessionId]
  );
  const customer = customerRows[0] || null;

  let { rows: convRows } = await pool.query(
    "select * from conversations where business_id = $1 and session_id = $2",
    [business.id, sessionId]
  );
  let conversation = convRows[0];
  if (!conversation) {
    const inserted = await pool.query(
      "insert into conversations (business_id, session_id) values ($1, $2) returning *",
      [business.id, sessionId]
    );
    conversation = inserted.rows[0];
  }

  const { rows: history } = await pool.query(
    "select role, content from messages where conversation_id = $1 order by created_at asc",
    [conversation.id]
  );

  await pool.query("insert into messages (conversation_id, role, content) values ($1, 'user', $2)", [
    conversation.id,
    message,
  ]);

  const apiMessages = [...history, { role: "user", content: message }];
  const systemPrompt = buildSystemPrompt(business, menuItems, customer);

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: apiMessages,
    }),
  });
  const data = await anthropicRes.json();
  if (!anthropicRes.ok || data.type === "error") {
    console.error("Error de Anthropic:", anthropicRes.status, JSON.stringify(data));
    return { replyText: "Perdona, tuvimos un problema técnico. ¿Puedes intentar de nuevo?", order: null };
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const rawText = textBlock ? textBlock.text : "";

  const match = rawText.match(/<order>([\s\S]*?)<\/order>/);
  let replyText = rawText.trim();
  let parsedOrder = null;
  if (match) {
    replyText = rawText.slice(0, match.index).trim();
    try {
      parsedOrder = JSON.parse(match[1].trim());
    } catch (e) {
      parsedOrder = null;
    }
  }

  // Guarda lo que Claude haya aprendido de este cliente (nombre, dirección), para no
  // volver a preguntarlo en la próxima conversación o pedido.
  if (parsedOrder) {
    const learnedName = parsedOrder.customer_name || null;
    const learnedAddress = (parsedOrder.delivery && parsedOrder.delivery.address) || null;
    if (learnedName || learnedAddress) {
      await pool.query(
        `insert into customers (business_id, session_id, name, last_address)
         values ($1, $2, $3, $4)
         on conflict (business_id, session_id) do update set
           name = coalesce(excluded.name, customers.name),
           last_address = coalesce(excluded.last_address, customers.last_address),
           updated_at = now()`,
        [business.id, sessionId, learnedName, learnedAddress]
      );
    }
  }

  // Guarda o actualiza el pedido PRIMERO, para tener su id disponible al armar el link de pago.
  let orderSnapshot = null;
  if (parsedOrder) {
    const { rows: recentOrders } = await pool.query(
      "select * from orders where conversation_id = $1 order by created_at desc limit 1",
      [conversation.id]
    );
    const latestOrder = recentOrders[0];
    const latestClosed = latestOrder && (latestOrder.status === "pago_verificado" || latestOrder.status === "cancelado");
    const status = deriveOrderStatus(parsedOrder);
    const delivery = parsedOrder.delivery || {};
    const customerName = parsedOrder.customer_name || (customer && customer.name) || null;

    if (latestOrder && !latestClosed) {
      const updated = await pool.query(
        `update orders set items=$1, total=$2, delivery_type=$3, delivery_address=$4, status=$5, customer_name=$6,
         confirmed_at = case when confirmed_at is null and $5 <> 'draft' then now() else confirmed_at end
         where id=$7 returning *`,
        [JSON.stringify(parsedOrder.items || []), parsedOrder.total || 0, delivery.type || null, delivery.address || null, status, customerName, latestOrder.id]
      );
      orderSnapshot = updated.rows[0];
    } else if ((!latestClosed || status === "draft") && (status !== "draft" || (parsedOrder.items || []).length > 0)) {
      // O es el primer pedido de la conversación, o el último ya se cerró (pagado/cancelado)
      // y el cliente claramente está armando uno nuevo y todavía sin confirmar. Si en cambio
      // el último pedido ya se cerró y Claude sigue repitiendo un estado confirmado (porque no
      // sabe que se cerró), no se crea nada — evita duplicar el pedido que ya se pagó/canceló.
      const inserted = await pool.query(
        `insert into orders (business_id, conversation_id, items, total, delivery_type, delivery_address, status, customer_name, confirmed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, case when $7 <> 'draft' then now() else null end) returning *`,
        [business.id, conversation.id, JSON.stringify(parsedOrder.items || []), parsedOrder.total || 0, delivery.type || null, delivery.address || null, status, customerName]
      );
      orderSnapshot = inserted.rows[0];
    }
  }

  // Ahora sí, sustituir los marcadores — ya con el pedido guardado y su id disponible.
  if (business.webpay_enabled && orderSnapshot && orderSnapshot.status === "confirmado" && !orderSnapshot.webpay_token) {
    try {
      const payLink = await createWebpayTransaction(business, orderSnapshot);
      replyText = replyText.replace(/\[LINK_PAGO\]/g, payLink);
    } catch (e) {
      console.error("Error creando transacción Webpay:", e);
      replyText = replyText.replace(/\[LINK_PAGO\]/g, "(no pudimos generar el link de pago, dinos si quieres que lo intentemos de nuevo)");
    }
  } else {
    replyText = replyText.replace(/\[LINK_PAGO\]/g, "");
  }
  replyText = replyText.replace(/\[DATOS_BANCARIOS\]/g, formatBankDetails(business));

  // Cambia cada [FOTO:<id>] por la URL pública de esa foto (solo si el producto es de este
  // negocio y sí tiene una imagen cargada) — la misma URL sirve para mostrarla inline en el
  // chat web y como "link" al mandarla como imagen nativa por WhatsApp.
  const photoIdMatches = [...replyText.matchAll(/\[FOTO:([0-9a-f-]{36})\]/gi)];
  const photos = [];
  if (photoIdMatches.length) {
    const ids = [...new Set(photoIdMatches.map((m) => m[1]))];
    const { rows: photoItems } = await pool.query(
      "select id from menu_items where business_id = $1 and id = any($2::uuid[]) and image_data is not null",
      [business.id, ids]
    );
    const validIds = new Set(photoItems.map((r) => r.id));
    replyText = replyText.replace(/\[FOTO:([0-9a-f-]{36})\]/gi, (full, id) => {
      if (!validIds.has(id)) return "";
      const url = `${PUBLIC_BACKEND_URL}/api/business/${business.slug}/menu-items/${id}/image`;
      photos.push(url);
      return url;
    });
  }

  if (!replyText.trim()) {
    replyText = parsedOrder && parsedOrder.confirmed
      ? "¡Listo! Tu pedido quedó confirmado."
      : "¿Me confirmas eso de nuevo?";
  }

  await pool.query("insert into messages (conversation_id, role, content) values ($1, 'assistant', $2)", [
    conversation.id,
    replyText,
  ]);

  syncOrderToSheetSafe(business, orderSnapshot);
  return { replyText, order: orderSnapshot, photos };
}

app.post("/api/chat/:slug", async (req, res) => {
  const { slug } = req.params;
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: "Falta sessionId o message" });

  try {
    const { rows: businessRows } = await pool.query("select * from businesses where slug = $1", [slug]);
    const business = businessRows[0];
    if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

    const { replyText, order, photos } = await processMessage(business, sessionId, message);
    res.json({ reply: replyText, order, photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Panel simple para que el negocio vea sus pedidos. Protegido con una clave por negocio
// (header x-dashboard-key), guardada en la columna dashboard_password de businesses.
app.get("/api/business/:slug/orders", async (req, res) => {
  const { rows: bizRows } = await pool.query("select id, dashboard_password from businesses where slug = $1", [
    req.params.slug,
  ]);
  const biz = bizRows[0];
  if (!biz) return res.status(404).json({ error: "Negocio no encontrado" });
  const isAdminOrders = ADMIN_PASSWORD && req.headers["x-dashboard-key"] === ADMIN_PASSWORD;
  if (biz.dashboard_password && req.headers["x-dashboard-key"] !== biz.dashboard_password && !isAdminOrders) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  const { rows } = await pool.query(
    "select * from orders where business_id = $1 and status != 'draft' order by created_at desc limit 100",
    [biz.id]
  );
  res.json(rows);
});

// "Carrito abandonado" = el cliente armó un pedido (tiene productos) pero nunca lo confirmó,
// y lleva un rato sin escribir. Para avisarle al negocio en la pestaña Pedidos.
const CARRITO_ABANDONADO_MINUTOS = 30;
app.get("/api/business/:slug/abandoned-orders", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows } = await pool.query(
    `select o.*, max(m.created_at) as last_message_at
     from orders o
     join conversations conv on conv.id = o.conversation_id
     left join messages m on m.conversation_id = conv.id
     where o.business_id = $1 and o.status = 'draft' and o.items::text <> '[]'
     group by o.id
     having max(m.created_at) < now() - interval '1 minute' * $2
     order by max(m.created_at) desc`,
    [business.id, CARRITO_ABANDONADO_MINUTOS]
  );
  res.json(rows);
});

// El negocio le manda un recordatorio a un cliente que dejó un carrito abandonado.
app.post("/api/business/:slug/orders/:orderId/remind", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows } = await pool.query("select * from orders where id = $1 and business_id = $2", [
    req.params.orderId,
    business.id,
  ]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

  const items = (order.items || []).map((it) => `${it.qty}x ${it.name}`).join(", ");
  const text = `¡Hola! Vimos que dejaste tu pedido a medio armar${items ? ` (${items})` : ""}. ¿Seguimos? Escríbeme cuando quieras retomarlo.`;

  try {
    await sendCustomerMessage(business, order.conversation_id, text);
    res.json({ sent: true });
  } catch (e) {
    console.error("Error enviando recordatorio de carrito abandonado:", e);
    res.status(500).json({ error: "No se pudo enviar el recordatorio" });
  }
});

// Lista los clientes que le han escrito a este negocio, con su última actividad,
// para la pestaña "Clientes" del panel.
app.get("/api/business/:slug/customers", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows } = await pool.query(
    `select c.session_id, c.name, c.last_address, c.created_at,
            max(m.created_at) as last_message_at, count(m.id) as message_count
     from customers c
     left join conversations conv on conv.business_id = c.business_id and conv.session_id = c.session_id
     left join messages m on m.conversation_id = conv.id
     where c.business_id = $1
     group by c.session_id, c.name, c.last_address, c.created_at
     order by last_message_at desc nulls last`,
    [business.id]
  );
  res.json(rows);
});

// Historial completo (con fecha y hora) de la conversación de un cliente puntual.
app.get("/api/business/:slug/customers/:sessionId/messages", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows: convRows } = await pool.query(
    "select id from conversations where business_id = $1 and session_id = $2",
    [business.id, req.params.sessionId]
  );
  if (!convRows[0]) return res.json({ messages: [] });

  const { rows: messages } = await pool.query(
    "select role, content, created_at from messages where conversation_id = $1 order by created_at asc",
    [convRows[0].id]
  );
  res.json({ messages });
});

// Borra la conversación de un cliente puntual (mensajes, conversación y su ficha de cliente).
// No toca sus pedidos — esos se administran aparte, desde la pestaña Pedidos.
app.delete("/api/business/:slug/customers/:sessionId", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows: convRows } = await pool.query(
    "select id from conversations where business_id = $1 and session_id = $2",
    [business.id, req.params.sessionId]
  );
  if (convRows[0]) {
    await pool.query("delete from messages where conversation_id = $1", [convRows[0].id]);
    await pool.query("delete from conversations where id = $1", [convRows[0].id]);
  }
  await pool.query("delete from customers where business_id = $1 and session_id = $2", [business.id, req.params.sessionId]);

  res.json({ deleted: true });
});

// El negocio marca manualmente que verificó la transferencia en su cuenta, o cambia el estado
// a cualquier otro valor válido. Misma clave.
app.patch("/api/orders/:orderId/status", async (req, res) => {
  const { status } = req.body; // 'draft' | 'confirmado' | 'pago_avisado' | 'pago_verificado' | 'cancelado'
  const { rows: orderRows } = await pool.query(
    "select o.conversation_id, o.status as previous_status, b.* from orders o join businesses b on b.id = o.business_id where o.id = $1",
    [req.params.orderId]
  );
  const row = orderRows[0];
  if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
  const isAdminStatus = ADMIN_PASSWORD && req.headers["x-dashboard-key"] === ADMIN_PASSWORD;
  if (row.dashboard_password && req.headers["x-dashboard-key"] !== row.dashboard_password && !isAdminStatus) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  const { rows } = await pool.query("update orders set status = $1 where id = $2 returning *", [
    status,
    req.params.orderId,
  ]);
  syncOrderToSheetSafe(row, rows[0]);

  if (status === "pago_verificado" && row.previous_status !== "pago_verificado") {
    notifyPaymentVerified(row, row.conversation_id).catch((e) =>
      console.error("Error avisándole al cliente que su pago fue verificado:", e)
    );
  }
  res.json(rows[0]);
});

// El negocio elimina un pedido por completo (por ejemplo, un pedido de prueba o duplicado). Misma clave.
app.delete("/api/orders/:orderId", async (req, res) => {
  const { rows: orderRows } = await pool.query(
    "select o.id, b.* from orders o join businesses b on b.id = o.business_id where o.id = $1",
    [req.params.orderId]
  );
  const row = orderRows[0];
  if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
  const isAdminDelete = ADMIN_PASSWORD && req.headers["x-dashboard-key"] === ADMIN_PASSWORD;
  if (row.dashboard_password && req.headers["x-dashboard-key"] !== row.dashboard_password && !isAdminDelete) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  // No se borra de verdad: se marca como "eliminado", así el pedido nunca desaparece de golpe
  // de un lado (el panel o la planilla) mientras sigue existiendo en el otro.
  const { rows } = await pool.query("update orders set status = 'eliminado' where id = $1 returning *", [
    req.params.orderId,
  ]);
  syncOrderToSheetSafe(row, rows[0]);
  res.json({ deleted: true });
});

// Página intermedia: Transbank exige que la redirección al formulario de pago sea un
// POST con el token, no un link directo. Esta página lo hace automáticamente.
app.get("/api/webpay/redirect/:token", async (req, res) => {
  const { rows } = await pool.query("select * from orders where webpay_token = $1", [req.params.token]);
  const order = rows[0];
  if (!order) return res.status(404).send("Pedido no encontrado");

  const { rows: bizRows } = await pool.query("select * from businesses where id = $1", [order.business_id]);
  const business = bizRows[0];
  const { environment } = await getWebpayTransaction(business);
  const webpayUrl = `${environment}/webpayserver/initTransaction`;

  res.send(`<!DOCTYPE html><html><body onload="document.forms[0].submit()">
    <p>Redirigiendo a Webpay...</p>
    <form method="POST" action="${webpayUrl}">
      <input type="hidden" name="token_ws" value="${req.params.token}" />
    </form>
  </body></html>`);
});

// Transbank redirige aquí (GET o POST) después del pago. Confirmamos la transacción
// y marcamos el pedido como pagado o rechazado según corresponda.
app.all("/api/webpay/return", async (req, res) => {
  const token = req.body.token_ws || req.query.token_ws;
  if (!token) return res.status(400).send("Falta token_ws");

  const { rows } = await pool.query("select * from orders where webpay_token = $1", [token]);
  const order = rows[0];
  if (!order) return res.status(404).send("Pedido no encontrado");

  const { rows: bizRows } = await pool.query("select * from businesses where id = $1", [order.business_id]);
  const business = bizRows[0];
  const { tx } = await getWebpayTransaction(business);

  try {
    const result = await tx.commit(token);
    const approved = result.status === "AUTHORIZED" || result.response_code === 0;
    await pool.query("update orders set status = $1 where id = $2", [
      approved ? "pago_verificado" : "cancelado",
      order.id,
    ]);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif; text-align:center; padding:60px 20px;">
      <h2>${approved ? "¡Pago exitoso!" : "El pago no se pudo completar"}</h2>
      <p>${approved ? "Ya puedes cerrar esta ventana y volver al chat." : "Puedes volver al chat e intentarlo de nuevo."}</p>
    </body></html>`);
  } catch (e) {
    console.error("Error confirmando pago Webpay:", e);
    res.status(500).send("Error al confirmar el pago");
  }
});

// Envía un mensaje de WhatsApp usando la API de Meta (Cloud API), con el número y token propios del negocio.
async function sendWhatsappMessage(business, to, text) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${business.whatsapp_phone_number_id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${business.whatsapp_access_token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Error enviando mensaje de WhatsApp:", res.status, err);
  }
}

// Envía una foto de producto como mensaje de imagen nativo de WhatsApp — Meta descarga la
// imagen directo desde nuestra URL pública, no hace falta subirla antes.
async function sendWhatsappImage(business, to, imageUrl) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${business.whatsapp_phone_number_id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${business.whatsapp_access_token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Error enviando imagen de WhatsApp:", res.status, err);
  }
}

// Le avisa al cliente que su pago quedó verificado: queda guardado en el historial del chat
// (lo ve si vuelve a abrir el chat web) y, si escribió por WhatsApp, se lo mandamos también ahí.
// Manda un mensaje del asistente a un cliente fuera del flujo normal de chat (por ejemplo,
// un aviso o un recordatorio disparado desde el panel): queda guardado en el historial (lo ve
// si vuelve a abrir el chat web) y, si escribió por WhatsApp, se lo mandamos también por ahí.
async function sendCustomerMessage(business, conversationId, text) {
  if (!conversationId) return;

  await pool.query("insert into messages (conversation_id, role, content) values ($1, 'assistant', $2)", [
    conversationId,
    text,
  ]);

  const { rows: convRows } = await pool.query("select session_id from conversations where id = $1", [conversationId]);
  const sessionId = convRows[0] && convRows[0].session_id;
  if (sessionId && sessionId.startsWith("whatsapp-") && business.whatsapp_phone_number_id && business.whatsapp_access_token) {
    await sendWhatsappMessage(business, sessionId.slice("whatsapp-".length), text);
  }
}

async function notifyPaymentVerified(business, conversationId) {
  await sendCustomerMessage(business, conversationId, "¡Buenas noticias! Confirmamos que recibimos tu pago. Ya estamos preparando tu pedido.");
}

// Decide si el bot debe quedarse callado en este momento (para que el negocio conteste a mano
// desde su propio celular). Dos formas de pausarlo: manual (switch en el panel) o por horario semanal.
function isBotPaused(business) {
  if (business.bot_paused) return true;
  if (!business.pause_schedule_enabled) return false;

  const schedule = business.pause_schedule || {};
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const dayMap = { Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat" };
  const day = dayMap[parts.find((p) => p.type === "weekday").value];
  const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const currentMinutes = hour * 60 + minute;

  const window = schedule[day];
  if (!window || !window.start || !window.end) return false;
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  return currentMinutes >= sh * 60 + sm && currentMinutes < eh * 60 + em;
}

// Meta llama esto UNA VEZ, al configurar el webhook en el panel de su app, para verificar
// que el servidor es tuyo. Hay que responder con el "challenge" tal cual si el token coincide.
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Acá llegan los mensajes reales de WhatsApp. Meta identifica el número al que le escribieron
// (phone_number_id) — con eso buscamos a qué negocio pertenece y usamos el mismo motor del chat web.
app.post("/api/whatsapp/webhook", async (req, res) => {
  res.sendStatus(200); // Confirmar recepción rápido; Meta reintenta si no respondes a tiempo.

  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const incomingMessage = value && value.messages && value.messages[0];
    if (!incomingMessage || incomingMessage.type !== "text") return; // ignora estados de entrega, etc.

    const phoneNumberId = value.metadata.phone_number_id;
    const from = incomingMessage.from; // número del cliente, en formato internacional sin '+'
    const text = incomingMessage.text.body;

    const { rows: businessRows } = await pool.query(
      "select * from businesses where whatsapp_phone_number_id = $1",
      [phoneNumberId]
    );
    const business = businessRows[0];
    if (!business) {
      console.error("Mensaje de WhatsApp para un phone_number_id sin negocio asociado:", phoneNumberId);
      return;
    }

    if (isBotPaused(business)) return; // El negocio está atendiendo a mano en este momento, el bot no interviene.

    const { replyText, photos } = await processMessage(business, `whatsapp-${from}`, text);
    // Las fotos van como mensajes de imagen nativos aparte, así que se sacan del texto
    // para no mandar además el link pelado como si fuera parte de la respuesta.
    const whatsappText = (photos || []).reduce((t, url) => t.split(url).join("").trim(), replyText);
    if (whatsappText) await sendWhatsappMessage(business, from, whatsappText);
    for (const url of photos || []) {
      await sendWhatsappImage(business, from, url);
    }
  } catch (err) {
    console.error("Error procesando webhook de WhatsApp:", err);
  }
});

// Google redirige aquí después de que el negocio autoriza el acceso. El "state" lleva el slug
// del negocio (lo arma el propio panel al construir el link de autorización).
app.get("/api/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const slug = state;
  const redirectBase = `${process.env.FRONTEND_APP_URL || ""}/ventas.html?negocio=${slug}`;

  if (error || !code) {
    console.log("Google callback con error o sin code:", { error, hasCode: !!code, FRONTEND_APP_URL: process.env.FRONTEND_APP_URL });
    return res.redirect(`${redirectBase}&google=error`);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_BACKEND_URL}/api/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error("Error obteniendo tokens de Google:", tokenData);
      return res.redirect(`${redirectBase}&google=error`);
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    // Crea una planilla nueva, ya con encabezados, en la cuenta de Drive del negocio.
    const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title: `Pedidos PONT` },
        sheets: [{ properties: { title: "Pedidos" } }],
      }),
    });
    const sheet = await createRes.json();
    if (!createRes.ok || !sheet.spreadsheetId) {
      console.error("Error creando la planilla de Google Sheets:", sheet);
      return res.redirect(`${redirectBase}&google=error`);
    }
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/Pedidos!A1:G1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [SHEET_HEADERS] }),
      }
    );

    await pool.query(
      `update businesses set google_refresh_token=$1, google_spreadsheet_id=$2, google_spreadsheet_url=$3,
       google_email=$4, google_sheets_enabled=true where slug=$5`,
      [tokenData.refresh_token, sheet.spreadsheetId, sheet.spreadsheetUrl, userInfo.email || null, slug]
    );

    res.redirect(`${redirectBase}&google=connected`);
  } catch (e) {
    console.error("Error en callback de Google:", e);
    res.redirect(`${redirectBase}&google=error`);
  }
});

// Desconectar Google Sheets de un negocio. Protegido con la clave del panel.
app.post("/api/business/:slug/google/disconnect", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;
  await pool.query(
    `update businesses set google_refresh_token=null, google_spreadsheet_id=null, google_spreadsheet_url=null,
     google_email=null, google_sheets_enabled=false where id=$1`,
    [business.id]
  );
  res.json({ disconnected: true });
});

// Prender o apagar la sincronización sin desconectar la cuenta.
app.post("/api/business/:slug/google/toggle", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;
  const { enabled } = req.body;
  await pool.query("update businesses set google_sheets_enabled=$1 where id=$2", [!!enabled, business.id]);
  res.json({ saved: true });
});

// Termina la conexión de WhatsApp Embedded Signup: cambia el "code" que dio el navegador por un
// token real, suscribe nuestra app a los mensajes de esa cuenta, y guarda el phone_number_id + token.
app.post("/api/business/:slug/whatsapp/connect", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { code, phoneNumberId, wabaId } = req.body;
  if (!code || !phoneNumberId || !wabaId) return res.status(400).json({ error: "Faltan datos de la conexión" });

  try {
    const tokenRes = await fetch(
      `https://graph.facebook.com/v23.0/oauth/access_token?client_id=${FACEBOOK_APP_ID}&client_secret=${FACEBOOK_APP_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("Error cambiando el code de WhatsApp por un token:", tokenData);
      return res.status(502).json({ error: "No se pudo validar la conexión con Meta" });
    }

    // Sin esto, los mensajes de esa cuenta nunca llegarían a nuestro webhook.
    await fetch(`https://graph.facebook.com/v23.0/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    await pool.query(
      "update businesses set whatsapp_phone_number_id=$1, whatsapp_access_token=$2 where id=$3",
      [phoneNumberId, tokenData.access_token, business.id]
    );
    res.json({ connected: true });
  } catch (e) {
    console.error("Error conectando WhatsApp:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// Crea el checkout de suscripción para un negocio: lo liga al plan compartido de $5.000/mes.
app.post("/api/business/:slug/subscription/create", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Falta el correo del negocio" });

  try {
    const mpRes = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Suscripción TeVende",
        external_reference: business.slug,
        payer_email: email,
        back_url: `${process.env.FRONTEND_APP_URL || ""}/ventas.html?negocio=${business.slug}`,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 5000,
          currency_id: "CLP",
        },
        status: "pending",
      }),
    });
    const data = await mpRes.json();
    if (!mpRes.ok || !data.init_point) {
      console.error("Error creando suscripción en Mercado Pago:", data);
      return res.status(502).json({ error: "No se pudo crear la suscripción" });
    }

    await pool.query(
      "update businesses set mp_preapproval_id=$1, subscription_email=$2, subscription_status='pending', mp_checkout_url=$4 where id=$3",
      [data.id, email, business.id, data.init_point]
    );
    res.json({ checkoutUrl: data.init_point });
  } catch (e) {
    console.error("Error creando suscripción:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// Mercado Pago avisa aquí cuando una suscripción se activa, se pausa o se cancela.
app.post("/api/mercadopago/webhook", async (req, res) => {
  res.sendStatus(200); // confirmar recepción rápido

  try {
    const preapprovalId = req.query["data.id"] || (req.body.data && req.body.data.id);
    const type = req.query.type || req.body.type;
    if (type !== "subscription_preapproval" && type !== "preapproval") return;
    if (!preapprovalId) return;

    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const preapproval = await mpRes.json();
    if (!mpRes.ok || !preapproval.external_reference) return;

    if (preapproval.status === "authorized") {
      await pool.query("update businesses set subscription_status=$1, last_payment_date=now() where slug=$2", [
        preapproval.status,
        preapproval.external_reference,
      ]);
    } else {
      await pool.query("update businesses set subscription_status=$1 where slug=$2", [
        preapproval.status, // 'authorized' | 'paused' | 'cancelled'
        preapproval.external_reference,
      ]);
    }
  } catch (e) {
    console.error("Error procesando webhook de Mercado Pago:", e);
  }
});

function checkAdminAuth(req, res) {
  if (!ADMIN_PASSWORD || req.headers["x-admin-key"] !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Clave de administrador incorrecta" });
    return false;
  }
  return true;
}

// Lista todos los negocios con sus links listos, para el panel de administrador (solo tú).
app.get("/api/admin/businesses", async (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const { rows } = await pool.query(
    "select slug, name, subscription_status, last_payment_date, invoice_status, created_at from businesses order by created_at desc"
  );
  res.json({ businesses: rows });
});

// Cambia a mano la fecha de último pago de un negocio (por ejemplo, si te pagó por transferencia).
app.put("/api/admin/businesses/:slug/last-payment", async (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const { last_payment_date } = req.body;
  await pool.query("update businesses set last_payment_date=$1 where slug=$2", [
    last_payment_date || null,
    req.params.slug,
  ]);
  res.json({ saved: true });
});

// Marca si ya emitiste la boleta/factura de ese negocio.
app.put("/api/admin/businesses/:slug/invoice-status", async (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const { invoice_status } = req.body;
  await pool.query("update businesses set invoice_status=$1 where slug=$2", [
    invoice_status === "emitida" ? "emitida" : "pendiente",
    req.params.slug,
  ]);
  res.json({ saved: true });
});

// Borra un negocio por completo (y todo lo que le pertenece: catálogo, conversaciones,
// mensajes, clientes y pedidos). A diferencia de "eliminar pedido" (que solo cambia el
// status), esto es un borrado real — el negocio deja de existir en la plataforma.
app.delete("/api/admin/businesses/:slug", async (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const { rows: bizRows } = await pool.query("select id from businesses where slug = $1", [req.params.slug]);
  const business = bizRows[0];
  if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

  await pool.query(
    "delete from messages where conversation_id in (select id from conversations where business_id = $1)",
    [business.id]
  );
  await pool.query("delete from orders where business_id = $1", [business.id]);
  await pool.query("delete from conversations where business_id = $1", [business.id]);
  await pool.query("delete from customers where business_id = $1", [business.id]);
  await pool.query("delete from menu_items where business_id = $1", [business.id]);
  await pool.query("delete from businesses where id = $1", [business.id]);

  res.json({ deleted: true });
});

// Cancela solos los pedidos por transferencia bancaria que llevan más de 24 horas confirmados
// sin que se verifique el pago (el agente le avisa este mismo plazo al cliente). No toca pedidos
// pagados con Webpay (webpay_token) ni los que se pagan al recibir (sin datos bancarios).
const PLAZO_TRANSFERENCIA_HORAS = 24;
async function cancelarPedidosVencidos() {
  try {
    const { rows } = await pool.query(
      `update orders o set status = 'cancelado'
       from businesses b
       where o.business_id = b.id
         and o.status in ('confirmado', 'pago_avisado')
         and o.webpay_token is null
         and b.bank_account_number is not null
         and o.confirmed_at < now() - interval '1 hour' * $1
       returning o.*, b.id as biz_id`,
      [PLAZO_TRANSFERENCIA_HORAS]
    );
    for (const order of rows) {
      const { rows: bizRows } = await pool.query("select * from businesses where id = $1", [order.business_id]);
      syncOrderToSheetSafe(bizRows[0], order);
    }
  } catch (e) {
    console.error("Error cancelando pedidos vencidos por falta de pago:", e);
  }
}
setInterval(cancelarPedidosVencidos, 30 * 60 * 1000);
cancelarPedidosVencidos();

// Los carritos abandonados (pedido armado, nunca confirmado) se eliminan solos después de 24
// horas sin actividad del cliente, y le queda un mensaje en la conversación explicando qué pasó.
const CARRITO_ABANDONADO_LIMITE_HORAS = 24;
async function eliminarCarritosAbandonados() {
  try {
    const { rows: candidates } = await pool.query(
      `select o.id, o.business_id, o.conversation_id
       from orders o
       join conversations conv on conv.id = o.conversation_id
       left join messages m on m.conversation_id = conv.id
       where o.status = 'draft' and o.items::text <> '[]'
       group by o.id
       having max(m.created_at) < now() - interval '1 hour' * $1`,
      [CARRITO_ABANDONADO_LIMITE_HORAS]
    );

    for (const c of candidates) {
      const { rows: bizRows } = await pool.query("select * from businesses where id = $1", [c.business_id]);
      const business = bizRows[0];
      if (!business) continue;

      const { rows: updated } = await pool.query("update orders set status = 'eliminado' where id = $1 returning *", [c.id]);
      await sendCustomerMessage(
        business,
        c.conversation_id,
        "Este pedido se eliminó automáticamente porque no se confirmó dentro de las 24 horas. Si todavía quieres hacerlo, dime y lo armamos de nuevo."
      );
      syncOrderToSheetSafe(business, updated[0]);
    }
  } catch (e) {
    console.error("Error eliminando carritos abandonados:", e);
  }
}
setInterval(eliminarCarritosAbandonados, 30 * 60 * 1000);
eliminarCarritosAbandonados();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PONT backend escuchando en :${port}`);
  console.log(`GOOGLE_CLIENT_ID cargado: ${GOOGLE_CLIENT_ID ? "sí (" + GOOGLE_CLIENT_ID.length + " caracteres)" : "NO"}`);
  console.log(`GOOGLE_CLIENT_SECRET cargado: ${GOOGLE_CLIENT_SECRET ? "sí (" + GOOGLE_CLIENT_SECRET.length + " caracteres)" : "NO"}`);
});

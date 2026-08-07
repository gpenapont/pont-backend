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
import "dotenv/config";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function formatBankDetails(b) {
  return [
    `Banco: ${b.bank_name || "[completar]"}`,
    `Tipo de cuenta: ${b.bank_account_type || "[completar]"}`,
    `N° de cuenta: ${b.bank_account_number || "[completar]"}`,
    `RUT: ${b.bank_rut || "[completar]"}`,
    `Enviar comprobante a: ${b.bank_email || "[completar]"}`,
  ].join("\n");
}

function buildSystemPrompt(business, menuItems) {
  const menuText = menuItems.map((i) => `- ${i.name}: $${i.price.toLocaleString("es-CL")}`).join("\n");
  const hasBankDetails = !!business.bank_account_number;

  const paymentSection = hasBankDetails
    ? `- Una vez confirmado, indica que el pago es por transferencia bancaria y comparte los datos escribiendo exactamente el marcador [DATOS_BANCARIOS] (nunca inventes un número de cuenta). Pide el comprobante.
- Si el cliente dice que ya transfirió, agradece y explica que el equipo verificará el pago antes de preparar el pedido. Nunca confirmes tú que el pago fue recibido.`
    : `- La forma de pago se coordina directamente al momento de la entrega o el intercambio. No inventes datos bancarios ni digital de pago que no tengas.`;

  return `Eres el agente de pedidos de ${business.name}. Los clientes te escriben online, desde el sitio web o un link compartido.

Importante: en la pantalla ya se mostró un saludo de bienvenida antes de que el cliente escribiera. No vuelvas a saludar ni a presentar el negocio de nuevo en tu primera respuesta, ve directo a ayudar con lo que el cliente pidió o preguntó.

${business.system_prompt_extra || ""}

Catálogo disponible (precios en CLP):
${menuText}

Tu trabajo:
- Ayudar al cliente a elegir productos y calcular el total.
- Responder en español neutro, amable pero sin modismos chilenos informales (nada de "bacán", "al tiro", "cachai", "po") y sin sonar tampoco excesivamente formal o robótico. Mantén las respuestas razonablemente breves, salvo que las instrucciones del negocio (más arriba) pidan un estilo más extenso, como explicaciones o recomendaciones detalladas. Sin markdown ni asteriscos.
- Si el cliente indica que no quiere agregar nada más (por ejemplo "nada más", "eso es todo", "solo eso", "no gracias"), no vuelvas a preguntar si quiere algo más. Avanza directo al siguiente paso: si falta el tipo de entrega, pregúntalo; si ya lo tienes, resume el pedido completo y pide confirmación.
- Antes de cerrar el pedido, pregunta si es despacho a domicilio o retiro en tienda. Si es despacho, pide dirección y comuna.
- Después resume lo que llevan, el tipo de entrega y pregunta si está todo correcto.
- Marcar el pedido como confirmado solo cuando el cliente lo confirme explícitamente.
${paymentSection}

Formato obligatorio de cada respuesta:
Primero tu respuesta al cliente en texto plano — esta parte nunca puede estar vacía, ni siquiera al confirmar el pedido, siempre debe haber un mensaje visible para el cliente. Después, en una línea aparte, agrega exactamente un bloque con el estado del pedido, así:
<order>{"items":[{"name":"...","qty":1,"price":0}],"total":0,"delivery":{"type":"despacho","address":"..."},"payment":{"status":"pendiente"},"confirmed":false}</order>

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
app.get("/api/business/:slug", async (req, res) => {
  const { rows: businessRows } = await pool.query("select id, slug, name, greeting from businesses where slug = $1", [
    req.params.slug,
  ]);
  const business = businessRows[0];
  if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

  const { rows: menuItems } = await pool.query(
    "select name, price, category from menu_items where business_id = $1 and active = true order by category, name",
    [business.id]
  );
  res.json({ slug: business.slug, name: business.name, greeting: business.greeting, menuItems });
});

// Helper compartido: busca el negocio por slug y valida la clave del panel (header x-dashboard-key).
// Devuelve la fila del negocio si todo bien, o null y ya responde el error si no.
async function getBusinessWithAuth(req, res) {
  const { rows } = await pool.query("select * from businesses where slug = $1", [req.params.slug]);
  const business = rows[0];
  if (!business) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return null;
  }
  if (business.dashboard_password && req.headers["x-dashboard-key"] !== business.dashboard_password) {
    res.status(401).json({ error: "Clave incorrecta" });
    return null;
  }
  return business;
}

// Panel de configuración: el negocio ve y edita su saludo, instrucciones, datos bancarios y catálogo.
app.get("/api/business/:slug/settings", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { rows: menuItems } = await pool.query(
    "select id, name, price, category, active from menu_items where business_id = $1 order by category, name",
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
    menuItems,
  });
});

app.put("/api/business/:slug/settings", async (req, res) => {
  const business = await getBusinessWithAuth(req, res);
  if (!business) return;

  const { greeting, system_prompt_extra, bank_name, bank_account_type, bank_account_number, bank_rut, bank_email } = req.body;
  await pool.query(
    `update businesses set greeting=$1, system_prompt_extra=$2, bank_name=$3, bank_account_type=$4,
     bank_account_number=$5, bank_rut=$6, bank_email=$7 where id=$8`,
    [greeting, system_prompt_extra, bank_name, bank_account_type, bank_account_number, bank_rut, bank_email, business.id]
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

app.post("/api/chat/:slug", async (req, res) => {
  const { slug } = req.params;
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: "Falta sessionId o message" });

  try {
    const { rows: businessRows } = await pool.query("select * from businesses where slug = $1", [slug]);
    const business = businessRows[0];
    if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

    const { rows: menuItems } = await pool.query(
      "select name, price from menu_items where business_id = $1 and active = true order by category, name",
      [business.id]
    );

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
    const systemPrompt = buildSystemPrompt(business, menuItems);

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
      return res.status(502).json({ error: "Error al llamar a Claude", detail: data.error || data });
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
    replyText = replyText.replace(/\[DATOS_BANCARIOS\]/g, formatBankDetails(business));
    if (!replyText.trim()) {
      // Nunca guardar un mensaje vacío: eso confunde a Claude en el siguiente turno y genera un bucle.
      replyText = parsedOrder && parsedOrder.confirmed
        ? "¡Listo! Tu pedido quedó confirmado."
        : "¿Me confirmas eso de nuevo?";
    }

    await pool.query("insert into messages (conversation_id, role, content) values ($1, 'assistant', $2)", [
      conversation.id,
      replyText,
    ]);

    let orderSnapshot = null;
    if (parsedOrder) {
      // Busca un pedido abierto para esta conversación (no pagado ni cancelado) y lo actualiza.
      // Solo se crea una fila nueva si no hay ninguna abierta todavía. Esto es lo que permite
      // que un aviso de pago posterior ("ya transferí") se enlace de vuelta al mismo pedido.
      const { rows: openOrders } = await pool.query(
        "select * from orders where conversation_id = $1 and status not in ('pago_verificado', 'cancelado') order by created_at desc limit 1",
        [conversation.id]
      );
      const status = deriveOrderStatus(parsedOrder);
      const delivery = parsedOrder.delivery || {};

      if (openOrders[0]) {
        const updated = await pool.query(
          `update orders set items=$1, total=$2, delivery_type=$3, delivery_address=$4, status=$5,
           confirmed_at = case when confirmed_at is null and $5 <> 'draft' then now() else confirmed_at end
           where id=$6 returning *`,
          [JSON.stringify(parsedOrder.items || []), parsedOrder.total || 0, delivery.type || null, delivery.address || null, status, openOrders[0].id]
        );
        orderSnapshot = updated.rows[0];
      } else if (status !== "draft" || (parsedOrder.items || []).length > 0) {
        const inserted = await pool.query(
          `insert into orders (business_id, conversation_id, items, total, delivery_type, delivery_address, status, confirmed_at)
           values ($1,$2,$3,$4,$5,$6,$7, case when $7 <> 'draft' then now() else null end) returning *`,
          [business.id, conversation.id, JSON.stringify(parsedOrder.items || []), parsedOrder.total || 0, delivery.type || null, delivery.address || null, status]
        );
        orderSnapshot = inserted.rows[0];
      }
    }

    res.json({ reply: replyText, order: orderSnapshot });
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
  if (biz.dashboard_password && req.headers["x-dashboard-key"] !== biz.dashboard_password) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  const { rows } = await pool.query(
    "select * from orders where business_id = $1 and status != 'draft' order by created_at desc limit 100",
    [biz.id]
  );
  res.json(rows);
});

// El negocio marca manualmente que verificó la transferencia en su cuenta, o cambia el estado
// a cualquier otro valor válido. Misma clave.
app.patch("/api/orders/:orderId/status", async (req, res) => {
  const { status } = req.body; // 'draft' | 'confirmado' | 'pago_avisado' | 'pago_verificado' | 'cancelado'
  const { rows: orderRows } = await pool.query(
    "select o.id, b.dashboard_password from orders o join businesses b on b.id = o.business_id where o.id = $1",
    [req.params.orderId]
  );
  const row = orderRows[0];
  if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
  if (row.dashboard_password && req.headers["x-dashboard-key"] !== row.dashboard_password) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  const { rows } = await pool.query("update orders set status = $1 where id = $2 returning *", [
    status,
    req.params.orderId,
  ]);
  res.json(rows[0]);
});

// El negocio elimina un pedido por completo (por ejemplo, un pedido de prueba o duplicado). Misma clave.
app.delete("/api/orders/:orderId", async (req, res) => {
  const { rows: orderRows } = await pool.query(
    "select o.id, b.dashboard_password from orders o join businesses b on b.id = o.business_id where o.id = $1",
    [req.params.orderId]
  );
  const row = orderRows[0];
  if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
  if (row.dashboard_password && req.headers["x-dashboard-key"] !== row.dashboard_password) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  await pool.query("delete from orders where id = $1", [req.params.orderId]);
  res.json({ deleted: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PONT backend escuchando en :${port}`));

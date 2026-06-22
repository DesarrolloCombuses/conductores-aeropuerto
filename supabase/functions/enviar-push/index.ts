// Edge Function: enviar-push
// La dispara un Database Webhook cuando se INSERTA un despacho en
// despachos_realizados. Si el itinerario es del grupo AEROPUERTO, envía una
// notificación Web Push a todos los celulares suscritos (aunque la app esté cerrada).
//
// Secrets necesarios (Project Settings → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY   = clave pública VAPID
//   VAPID_PRIVATE_KEY  = clave privada VAPID
//   VAPID_SUBJECT      = mailto:administrativo@combuses.com.co
// (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya están disponibles automáticamente.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:administrativo@combuses.com.co";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Itinerarios del grupo AEROPUERTO (ids de config.js)
const AEROPUERTO_IDS = ["3385", "4413", "4501", "4503", "4507"];

function esAeropuerto(rec: Record<string, unknown>): boolean {
  const id = String(rec.itinerario_id ?? "");
  if (AEROPUERTO_IDS.includes(id)) return true;
  const nombre = String(rec.itinerario ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return nombre.startsWith("aeropuerto");
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    // El webhook de Supabase envía { type, table, record, old_record }
    const record = payload.record ?? payload.new ?? payload;
    const tipo = payload.type ?? "INSERT";

    if (!record || tipo !== "INSERT") {
      return new Response(JSON.stringify({ skip: "no es INSERT" }), { status: 200 });
    }
    if (!esAeropuerto(record)) {
      return new Response(JSON.stringify({ skip: "no AEROPUERTO" }), { status: 200 });
    }

    const bus = record.interno ?? record.vehicle_id ?? "—";
    const cuerpo = {
      title: `¡Nuevo despacho! Bus ${bus}`,
      body: `Será despachado por: ${record.itinerario ?? "Sin itinerario"}`,
      url: "./",
    };
    const notif = JSON.stringify(cuerpo);

    const { data: subs, error } = await supabase.from("push_subscriptions").select("*");
    if (error) throw error;

    let enviados = 0;
    let borrados = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notif,
        );
        enviados++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410 = la suscripción ya no existe → la borramos
        if (code === 404 || code === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          borrados++;
        }
      }
    }

    return new Response(JSON.stringify({ enviados, borrados }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});

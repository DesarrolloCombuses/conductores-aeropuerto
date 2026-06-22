// Edge Function: consultar-programacion
// La llama la app pública de conductores. Recibe una fecha (YYYY-MM-DD) y
// devuelve la programación de ese día desde programacion_filas. La tabla está
// cerrada al público (RLS sin acceso para anon): el acceso se hace aquí con la
// service_role, del lado servidor.
//
// Cuando hay varias programaciones con filas en la misma fecha, se toma la más
// reciente (programacion_id más alto).
//
// Petición (POST JSON):  { "fecha": "2026-04-29" }
// Respuesta: { success: true, fecha, total, filas: [{ row_key, base, vehiculo }] }

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return json({ success: false, message: "Método no permitido" }, 405);
  }

  try {
    const { fecha } = await req.json().catch(() => ({}));
    const dia = String(fecha ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
      return json({ success: false, message: "Fecha inválida (use AAAA-MM-DD)." }, 400);
    }

    // Todas las filas de esa fecha (con la programación a la que pertenecen).
    const { data, error } = await supabase
      .from("programacion_filas")
      .select("row_key, base, vehiculo, programacion_id")
      .eq("fecha", dia)
      .limit(2000);

    if (error) throw error;
    const todas = data ?? [];

    if (!todas.length) {
      return json({ success: true, fecha: dia, total: 0, filas: [] });
    }

    // Quedarnos solo con la programación más reciente (programacion_id más alto)
    // que tenga filas en esa fecha, para no mezclar versiones.
    let maxPid = -Infinity;
    for (const f of todas) {
      const pid = Number(f.programacion_id);
      if (Number.isFinite(pid) && pid > maxPid) maxPid = pid;
    }
    const filas = todas
      .filter((f) => Number(f.programacion_id) === maxPid)
      .map((f) => ({ row_key: f.row_key, base: f.base, vehiculo: f.vehiculo }));

    return json({ success: true, fecha: dia, total: filas.length, filas });
  } catch (e) {
    console.error(e);
    return json({ success: false, message: String(e) }, 500);
  }
});

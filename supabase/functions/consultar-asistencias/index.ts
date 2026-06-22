// Edge Function: consultar-asistencias
// La llama la app pública de conductores. Recibe una cédula (dni), valida que
// el colaborador exista y pueda usar la app, y devuelve SOLO sus registros de
// asistencia (entradas/salidas). Las tablas asistencias y colaboradores quedan
// cerradas al público (RLS sin acceso para anon): el acceso a los datos se hace
// aquí con la service_role, del lado servidor.
//
// Petición (POST JSON):
//   { "dni": "12345678", "dias": 30 }   // dias es opcional (default 30, máx 90)
//
// Respuesta:
//   { success: true, colaborador: { nombre, dni }, asistencias: [ ... ] }
//
// (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya están disponibles automáticamente.)

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

// Solo se devuelven al conductor columnas no sensibles (sin foto_path,
// integraciones buk/sonar, registrado_por, etc.)
const COLUMNAS =
  "fecha,hora,sentido,jornada,base_operativa,punto_operativo,vehiculo_reporte,observacion";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ success: false, message: "Método no permitido" }, 405);
  }

  try {
    const { dni, dias } = await req.json().catch(() => ({}));

    const cedula = String(dni ?? "").trim();
    if (!cedula) {
      return json({ success: false, message: "Falta la cédula." }, 400);
    }

    // Ventana de consulta: por defecto 30 días, máximo 90.
    let ventana = Number.parseInt(String(dias ?? "30"), 10);
    if (!Number.isFinite(ventana) || ventana <= 0) ventana = 30;
    if (ventana > 90) ventana = 90;

    // 1) Validar colaborador por cédula (dni es UNIQUE).
    const { data: colab, error: errColab } = await supabase
      .from("colaboradores")
      .select("id, nombre, dni, estado, puede_usar_app")
      .eq("dni", cedula)
      .maybeSingle();

    if (errColab) throw errColab;
    if (!colab) {
      return json(
        { success: false, message: "La cédula no está registrada." },
        404,
      );
    }
    if (colab.puede_usar_app === false) {
      return json(
        { success: false, message: "Este colaborador no tiene acceso a la app." },
        403,
      );
    }

    // 2) Fecha de corte (YYYY-MM-DD) para filtrar por los últimos N días.
    const corte = new Date();
    corte.setDate(corte.getDate() - ventana);
    const desde = corte.toISOString().slice(0, 10);

    // 3) Asistencias del colaborador, más recientes primero.
    const { data: asistencias, error: errAsis } = await supabase
      .from("asistencias")
      .select(COLUMNAS)
      .eq("colaborador_id", colab.id)
      .gte("fecha", desde)
      .order("fecha", { ascending: false })
      .order("hora", { ascending: false })
      .limit(500);

    if (errAsis) throw errAsis;

    return json({
      success: true,
      colaborador: { nombre: colab.nombre ?? "", dni: colab.dni },
      dias: ventana,
      asistencias: asistencias ?? [],
    });
  } catch (e) {
    console.error(e);
    return json({ success: false, message: String(e) }, 500);
  }
});

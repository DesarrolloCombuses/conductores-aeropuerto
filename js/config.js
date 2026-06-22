// Configuración Supabase para la web pública.
// Estas son las credenciales PÚBLICAS (anon key). Es seguro publicarlas
// siempre que la tabla llegadas_104 tenga Row Level Security activada
// con política de solo SELECT para el rol anon.
window.APP_CONFIG = {
    // Versión visible de la app — debe coincidir con sw.js
    APP_VERSION: "v1.7.4",
    SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",
    TABLA: "llegadas_104",
    // Clave PÚBLICA VAPID para Web Push (la privada va como secret en Supabase)
    VAPID_PUBLIC_KEY: "BPtESMW7un67_F9YGzFGZhugVdqbfrcBhH7k_HCy3I1sg89y-9lvXoFaOzIA7vJ4_49Nz1S7N9o2bdHZDTMm7XE",
    // Tabla donde se guardan las suscripciones push de los conductores
    TABLA_PUSH: "push_subscriptions",
    // Edge Function que asigna itinerario a un bus en Sonar
    SONAR_DISPATCH_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-dispatch",
    // Edge Function que consulta GET_DispatchedVehicles
    SONAR_DESPACHOS_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-despachos",
    // Edge Function que cancela un despacho en Sonar
    SONAR_CANCEL_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-cancel",
    // Nombre de la tabla donde se guardan los despachos realizados
    TABLA_REALIZADOS: "despachos_realizados",
    // Tabla de vehículos para el despacho manual (columnas: ID, INTERNO, Placa)
    TABLA_VEHICULOS: "vehiculossonar",
    // CSV publicado de Google Sheets con la nómina de conductores
    // Columnas: dr_id, cedula, fleet, nombre, status, email, celular
    CONDUCTORES_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vThNrFZLbNklMFtPeg0wF4TA1vZHnZ4YNMmGcnHfty_RoNuAQw__iV2GMXqTsv36MPiks1ARpYui1JK/pub?gid=0&single=true&output=csv",
    // Lookback por defecto (horas) para la pestaña Despachos
    DESPACHOS_LOOKBACK_HORAS: 5,
    // Solo se muestran los despachos cuyo itDesc esté en esta lista
    // (comparación insensible a mayúsculas y tildes).
    DESPACHOS_ITINERARIOS_PERMITIDOS: [
        "Nutibara-exposiciones-tunel-aeropuerto",
        "Aeropuerto-San Diego-Tunel",
        "Aeropuerto-autopista-terminalnorte",
    ],
    // Itinerarios disponibles para asignar (id se envía a Sonar)
    ITINERARIOS: [
        { id: "3385", grupo: "AEROPUERTO",   nombre: "Aeropuerto-San Diego-Tunel" },
        { id: "3387", grupo: "NUTIBARA",     nombre: "Nutibara-Aeropuerto-Autopista" },
        { id: "3394", grupo: "NUTIBARA",     nombre: "Nutibara-Aeropuerto-Variante Palmas" },
        { id: "3395", grupo: "SANDIEGO",     nombre: "San Diego-Aeropuerto-Variante Palmas" },
        { id: "4413", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Exposiciones" },
        { id: "4501", grupo: "AEROPUERTO",   nombre: "Aeropuerto-autopista-terminalnorte" },
        { id: "4502", grupo: "EXPOSICIONES", nombre: "Nutibara-exposiciones-tunel-aeropuerto" },
        { id: "4503", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Tunel-Exposiciones-Nutibara" },
        { id: "4507", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Tunel-ccsandiego" },
        { id: "4505", grupo: "SANDIEGO",     nombre: "Almacentro-Tunel-Aeropuerto" },
    ],
    // Centro inicial del mapa (Aeropuerto JMC)
    MAP_CENTER: { lat: 6.170989, lng: -75.431152 },
    MAP_ZOOM: 14,
};

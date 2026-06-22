# Consulta Llegadas JMC — Conductores

App web (PWA) de **solo consulta** para los conductores del Aeropuerto JMC — Combuses.

Muestra en tiempo real las llegadas y los despachos, **sin necesidad de iniciar sesión**.
Los conductores **no pueden despachar ni modificar datos**: solo consultan.

## Características

- **Sin login**: acceso directo con la clave pública de Supabase (rol `anon`, solo lectura).
- **Listas**: llegadas ordenadas por hora, con el itinerario en cada fila.
- **Realizados**: historial de despachos (solo lectura).
- **Mapa**: ubicación de los buses en vivo.
- **Alerta en tiempo real**: cuando se hace un despacho de un itinerario del grupo
  **AEROPUERTO**, suena una alerta (banner + sonido + vibración + notificación del
  sistema) en todos los dispositivos con la app abierta.
- **Instalable** como PWA en el celular.

## Tecnología

HTML + CSS + JavaScript (vanilla) sobre **Supabase** (datos + Realtime).
Sin paso de build: se publica como sitio estático (GitHub Pages).

## Relación con la app de operaciones

Esta app comparte la base de datos Supabase con la app de despachos
([despachosaeropuerto](https://github.com/DesarrolloCombuses/despachosaeropuerto)),
pero solo con permisos de **lectura** para el rol anónimo.
